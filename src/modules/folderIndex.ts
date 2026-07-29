// @ajan: cursor · @etiket: katman-2, p1, p2-1, p2-4, folderIndex, incomplete-index
import { getPref } from "../utils/prefs";
import { parseFilenameMetadata } from "./filenameMetadata";
import { readJsonOrQuarantine, writeJsonAtomic } from "../utils/atomicJson";

// Gecko globals available in the Zotero sandbox but not in the type defs.
declare const IOUtils: any;
declare const PathUtils: any;

/** Align with Katman strategy / MAX_LIBRARY_PDFS (99999). */
export const MAX_INDEX_FILES = 99999;
export const MAX_WALK_DEPTH = 8;
export const INDEX_SCHEMA_VERSION = 1;

export type IndexTruncateReason = "maxFiles" | "maxDepth" | null;

export interface IndexBuildMeta {
  incomplete: boolean;
  truncateReason: IndexTruncateReason;
  discovered: number;
  cappedAt: number;
  maxDepth: number;
}

let lastBuildMeta: IndexBuildMeta = {
  incomplete: false,
  truncateReason: null,
  discovered: 0,
  cappedAt: MAX_INDEX_FILES,
  maxDepth: MAX_WALK_DEPTH,
};

export function getLastIndexBuildMeta(): IndexBuildMeta {
  return { ...lastBuildMeta };
}

/** Incomplete scans must not drive OA / high-confidence automation. */
export function isFolderIndexComplete(
  meta: IndexBuildMeta = getLastIndexBuildMeta(),
): boolean {
  return !meta.incomplete;
}

/** @internal test helper — simulate a truncated scan result. */
export function __setLastIndexBuildMetaForTests(meta: IndexBuildMeta): void {
  lastBuildMeta = { ...meta };
}

/** Serialize all index mutations in-process (build + registerDownloadedFile). */
let indexMutateChain: Promise<unknown> = Promise.resolve();

function enqueueIndexMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexMutateChain.then(fn, fn) as Promise<T>;
  indexMutateChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * A persistent, incremental, multi-root index of the PDF files found under the
 * user's watched folders. This is the foundation of full automation:
 *
 * - **Multi-root:** watches a LIST of roots (set once), recursively. New
 *   sub-folders/files are picked up automatically — no path maintenance.
 * - **Persistent:** the index is cached to disk, so it survives restarts and
 *   is available instantly.
 * - **Incremental:** on rebuild, files whose mtime is unchanged reuse their
 *   cached derived data; only new/changed files are reprocessed.
 * - **Linked base (P2-1):** optional merge of Zotero `baseAttachmentPath`.
 *
 * Filename DOI/ISBN/title extraction adapted for index enrichment (P2-1);
 * watch-root / linked-base merge patterns informed by zotmoov + watch-folder
 * (GPL) — selective port, not a product copy.
 */
export interface IndexedFile {
  path: string;
  mtime: number;
  name: string; // file name without extension
  norm: string; // normalized name (NFKD + mark strip + lowercase), for matching
  alnum: string; // lowercased alphanumeric of the name, for DOI/ISBN matching
  /** Optional size in bytes when available from IOUtils.stat. */
  size?: number;
  /** DOI parsed from filename (cheap); PDF-embedded DOI is a later phase. */
  doi?: string;
  isbn?: string;
  /** Best-effort title from filename metadata parser. */
  pdfTitle?: string;
}

/** Parse the user-facing semicolon/newline-separated roots preference. */
export function parseWatchRoots(raw: string): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const value of (raw || "").split(/[;\n\r]+/)) {
    let root = value.trim();
    const isDriveRoot = /^[a-z]:[\\/]$/i.test(root);
    if (root.length > 1 && !isDriveRoot) {
      root = root.replace(/[\\/]+$/, "");
    }
    if (!root) continue;
    // Windows paths are case-insensitive. Lowercasing is also harmless for
    // de-duplication on the platforms supported by Zotero.
    const key = root.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

/**
 * Merge configured watch roots with Zotero's linked attachment base directory.
 * Pure — used by getWatchRoots and unit tests.
 */
export function mergeWatchRoots(
  configured: string[],
  linkedBase: string | null | undefined,
  useLinkedBase: boolean,
): string[] {
  const parts = [...configured];
  if (useLinkedBase) {
    const base = (linkedBase || "").trim();
    if (base) parts.push(base);
  }
  return parseWatchRoots(parts.join(";"));
}

/** Zotero Advanced → Files and Folders → Linked Attachment Base Directory. */
export function readLinkedAttachmentBase(): string {
  try {
    const value = Zotero.Prefs.get("baseAttachmentPath");
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export function isUseLinkedAttachmentBaseEnabled(): boolean {
  const value = getPref("pdf.useLinkedAttachmentBase");
  return value === undefined || value === true;
}

// Local copy of the normalizer (kept here to avoid a circular import with
// pdfSources.ts). Must stay in sync with normalizeSearchText there.
function normalize(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

let memCache: IndexedFile[] | null = null;
let memCacheAt = 0;

function indexFilePath(): string {
  return PathUtils.join(
    (Zotero as any).DataDirectory.dir,
    "zpdfmanager-folder-index.json",
  );
}

/**
 * Build or refresh a single index entry. Reuses `prev` when mtime matches;
 * always ensures doi/isbn/pdfTitle from the filename when cheap to derive.
 */
export function indexEntryFromDiscovery(
  path: string,
  mtime: number,
  prev?: IndexedFile | null,
  size?: number,
): IndexedFile {
  if (prev && prev.mtime === mtime && prev.name && prev.norm && prev.alnum) {
    const migrated = attachFilenameIdentifiers(prev);
    if (typeof size === "number" && size > 0 && migrated.size !== size) {
      return { ...migrated, size };
    }
    return migrated;
  }
  const name = path.replace(/^.*[\\/]/, "").replace(/\.pdf$/i, "");
  const entry: IndexedFile = {
    path,
    mtime,
    name,
    norm: normalize(name),
    alnum: name.toLowerCase().replace(/[^a-z0-9]+/g, ""),
  };
  if (typeof size === "number" && size > 0) entry.size = size;
  return attachFilenameIdentifiers(entry);
}

function attachFilenameIdentifiers(entry: IndexedFile): IndexedFile {
  if (entry.doi || entry.isbn || entry.pdfTitle) return entry;
  try {
    const meta = parseFilenameMetadata(`${entry.name}.pdf`);
    const next: IndexedFile = { ...entry };
    if (meta.doi) next.doi = meta.doi;
    if (meta.isbn) next.isbn = meta.isbn;
    if (meta.title) next.pdfTitle = meta.title;
    return next;
  } catch {
    return entry;
  }
}

/** The list of watched roots (set once). Falls back to the legacy single folder. */
export function getWatchRoots(): string[] {
  const raw = ((getPref("pdf.watchRoots") as string) || "").trim();
  let configured = parseWatchRoots(raw);
  if (!configured.length) {
    const legacy = ((getPref("pdf.localFolder") as string) || "").trim();
    if (legacy) configured = parseWatchRoots(legacy);
  }
  return mergeWatchRoots(
    configured,
    readLinkedAttachmentBase(),
    isUseLinkedAttachmentBaseEnabled(),
  );
}

async function loadPersisted(): Promise<Map<string, IndexedFile>> {
  const map = new Map<string, IndexedFile>();
  try {
    const p = indexFilePath();
    const parsed = await readJsonOrQuarantine(p);
    if (parsed == null) return map;
    // Support legacy bare array and sürümlü envelope.
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { data?: unknown }).data)
        ? (parsed as { data: unknown[] }).data
        : null;
    if (!arr) return map;
    for (const candidate of arr) {
      const f = candidate as Partial<IndexedFile>;
      if (
        typeof f.path === "string" &&
        typeof f.mtime === "number" &&
        typeof f.name === "string" &&
        typeof f.norm === "string" &&
        typeof f.alnum === "string"
      ) {
        map.set(f.path, f as IndexedFile);
        map.set(f.path.toLocaleLowerCase(), f as IndexedFile);
      }
    }
  } catch (e) {
    ztoolkit.log("Folder index load failed (quarantined if corrupt)", e);
  }
  return map;
}

async function persist(files: IndexedFile[]): Promise<void> {
  try {
    await writeJsonAtomic(indexFilePath(), {
      schemaVersion: INDEX_SCHEMA_VERSION,
      generation: Date.now(),
      savedAt: new Date().toISOString(),
      incomplete: lastBuildMeta.incomplete,
      truncateReason: lastBuildMeta.truncateReason,
      data: files,
    });
  } catch (e) {
    ztoolkit.log("Folder index persist failed", e);
  }
}

type WalkOut = { path: string; mtime: number; size?: number }[];

async function walk(
  dir: string,
  depth: number,
  out: WalkOut,
  state: { incomplete: boolean; truncateReason: IndexTruncateReason },
): Promise<void> {
  if (out.length >= MAX_INDEX_FILES) {
    state.incomplete = true;
    state.truncateReason = "maxFiles";
    return;
  }
  if (depth > MAX_WALK_DEPTH) {
    state.incomplete = true;
    if (!state.truncateReason) state.truncateReason = "maxDepth";
    return;
  }
  let children: string[] = [];
  try {
    children = await IOUtils.getChildren(dir);
  } catch {
    return; // unreadable folder
  }
  for (const child of children) {
    if (out.length >= MAX_INDEX_FILES) {
      state.incomplete = true;
      state.truncateReason = "maxFiles";
      return;
    }
    try {
      const info = await IOUtils.stat(child);
      if (info.type === "directory") {
        await walk(child, depth + 1, out, state);
      } else if (/\.pdf$/i.test(child)) {
        out.push({
          path: child,
          mtime: Number(info.lastModified || 0),
          size: Number(info.size || 0) || undefined,
        });
      }
    } catch {
      /* skip unreadable entry */
    }
  }
}

/**
 * Build (or refresh) the folder index across all watched roots. Uses a short
 * in-memory cache; pass `force` to rescan immediately. Unchanged files (same
 * mtime) reuse their cached entry so derived data is not recomputed.
 */
export async function buildIndex(force = false): Promise<IndexedFile[]> {
  return enqueueIndexMutation(() => buildIndexLocked(force));
}

async function buildIndexLocked(force = false): Promise<IndexedFile[]> {
  const now = Date.now();
  if (!force && memCache && now - memCacheAt < 60000) return memCache;

  const roots = getWatchRoots();
  const persisted = await loadPersisted();
  const discovered: WalkOut = [];
  const walkState: {
    incomplete: boolean;
    truncateReason: IndexTruncateReason;
  } = { incomplete: false, truncateReason: null };
  for (const root of roots) {
    if (root) await walk(root, 0, discovered, walkState);
  }

  lastBuildMeta = {
    incomplete: walkState.incomplete,
    truncateReason: walkState.truncateReason,
    discovered: discovered.length,
    cappedAt: MAX_INDEX_FILES,
    maxDepth: MAX_WALK_DEPTH,
  };
  if (walkState.incomplete) {
    ztoolkit.log(
      `Folder index INCOMPLETE: reason=${walkState.truncateReason} discovered≈${discovered.length} cap=${MAX_INDEX_FILES}`,
    );
  }

  // A child root may also be contained by another configured root. Keep one
  // entry per path so matching never sees artificial duplicates.
  const unique = new Map<
    string,
    { path: string; mtime: number; size?: number }
  >();
  for (const file of discovered) {
    unique.set(file.path.toLocaleLowerCase(), file);
  }

  const index: IndexedFile[] = Array.from(unique.values()).map((d) => {
    const prev =
      persisted.get(d.path) || persisted.get(d.path.toLocaleLowerCase());
    return indexEntryFromDiscovery(d.path, d.mtime, prev, d.size);
  });

  memCache = index;
  memCacheAt = now;
  await persist(index);
  ztoolkit.log(
    `Folder index: ${index.length} PDFs across ${roots.length} root(s)` +
      (lastBuildMeta.incomplete
        ? ` [INCOMPLETE:${lastBuildMeta.truncateReason}]`
        : ""),
  );
  return index;
}

/** Drop the in-memory cache so the next buildIndex() rescans. */
export function invalidateIndex(): void {
  memCache = null;
  memCacheAt = 0;
}

/**
 * Register a newly written PDF (e.g. OA → downloads/) into the live index
 * without a full rescan (P2-4).
 */
export async function registerDownloadedFile(
  path: string,
): Promise<IndexedFile | null> {
  return enqueueIndexMutation(() => registerDownloadedFileLocked(path));
}

async function registerDownloadedFileLocked(
  path: string,
): Promise<IndexedFile | null> {
  try {
    const stat = await IOUtils.stat(path);
    const mtime =
      typeof stat?.lastModified === "number" ? stat.lastModified : Date.now();
    const size = typeof stat?.size === "number" ? stat.size : undefined;
    const entry = indexEntryFromDiscovery(path, mtime, null, size);
    if (memCache) {
      const key = path.toLocaleLowerCase();
      const next = memCache.filter((f) => f.path.toLocaleLowerCase() !== key);
      next.push(entry);
      memCache = next;
      memCacheAt = Date.now();
      await persist(next);
    } else {
      invalidateIndex();
    }
    return entry;
  } catch (e) {
    ztoolkit.log("registerDownloadedFile failed", path, e);
    invalidateIndex();
    return null;
  }
}
