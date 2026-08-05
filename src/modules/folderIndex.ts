// @ajan: cursor · @etiket: katman-2, folderIndex, watch-root-parent
import { getPref } from "../utils/prefs";
import { parseFilenameMetadata } from "./filenameMetadata";
import { readJsonOrQuarantine, writeJsonAtomic } from "../utils/atomicJson";
import { RunAbortedError } from "../utils/cancelToken";

// Gecko globals available in the Zotero sandbox but not in the type defs.
declare const IOUtils: any;
declare const PathUtils: any;

/** Align with Katman strategy / MAX_LIBRARY_PDFS (99999). */
export const MAX_INDEX_FILES = 99999;
export const MAX_WALK_DEPTH = 8;
export const INDEX_SCHEMA_VERSION = 1;

export type IndexTruncateReason = "maxFiles" | "maxDepth" | "ioError" | null;

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

type FolderIO = {
  getChildren: (dir: string) => Promise<string[]>;
  stat: (
    path: string,
  ) => Promise<{ type: string; lastModified?: number; size?: number }>;
};

const defaultFolderIO: FolderIO = {
  getChildren: (dir) => IOUtils.getChildren(dir),
  stat: (path) => IOUtils.stat(path),
};

let folderIO: FolderIO = defaultFolderIO;

/** @internal — inject IO for walker incomplete/IO-error tests. */
export function __setFolderIOForTests(io: FolderIO | null): void {
  folderIO = io || defaultFolderIO;
}

/** @internal — expose mutation queue sequencing for tests. */
export function __enqueueIndexMutationForTests<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return enqueueIndexMutation(fn);
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
 * Default local PDF search root (full OneDrive tree: Zotero / Kütüphane /
 * Dışı buckets and nested folders). Indexing walks recursively up to
 * MAX_WALK_DEPTH. Must stay in sync with prefs.js + preference migrate.
 */
export const DEFAULT_WATCH_ROOT = "D:\\OneDrive\\1A_E_KAYNAKLARIM";

/** @deprecated Use DEFAULT_WATCH_ROOT — kept as alias for older callers. */
export const DEFAULT_DISI_WATCH_ROOT = DEFAULT_WATCH_ROOT;

/**
 * Append ``pathToAdd`` to a watchRoots string when not already listed
 * (case-insensitive exact match). Returns semicolon-joined roots.
 */
export function ensurePathInWatchRoots(
  current: string,
  pathToAdd: string,
): string {
  const roots = parseWatchRoots(current || "");
  const want = (pathToAdd || "").trim().replace(/[\\/]+$/, "");
  if (!want) return roots.join(";");
  const wantKey = want.toLocaleLowerCase();
  if (roots.some((r) => r.toLocaleLowerCase() === wantKey)) {
    return roots.join(";");
  }
  return parseWatchRoots([...roots, want].join(";")).join(";");
}

function watchRootKey(root: string): string {
  return root.toLocaleLowerCase().replace(/[\\/]+$/, "");
}

/**
 * Drop roots nested under another listed root (parent alone covers the tree).
 * Example: parent + ``…\\Kütüphane Dışı Kaynaklar`` → parent only.
 */
export function collapseNestedWatchRoots(current: string): string {
  const roots = parseWatchRoots(current || "");
  const keys = roots.map(watchRootKey);
  const kept = roots.filter((_root, i) => {
    const key = keys[i];
    if (!key) return false;
    return !keys.some((other, j) => {
      if (i === j || !other) return false;
      return key.startsWith(`${other}\\`) || key.startsWith(`${other}/`);
    });
  });
  return kept.join(";");
}

/**
 * Ensure ``DEFAULT_WATCH_ROOT`` is listed and collapse nested children of it
 * (or any parent/child pair). Used by preference migrate on upgrade.
 */
export function normalizeDefaultWatchRoots(current: string): string {
  const withDefault = ensurePathInWatchRoots(
    current || "",
    DEFAULT_WATCH_ROOT,
  );
  return collapseNestedWatchRoots(withDefault);
}

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
  signal?: AbortSignal | null,
): Promise<void> {
  if (signal?.aborted) {
    throw new RunAbortedError("folder walk aborted");
  }
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
    children = await folderIO.getChildren(dir);
  } catch {
    state.incomplete = true;
    if (!state.truncateReason) state.truncateReason = "ioError";
    return;
  }
  for (const child of children) {
    if (signal?.aborted) {
      throw new RunAbortedError("folder walk aborted");
    }
    if (out.length >= MAX_INDEX_FILES) {
      state.incomplete = true;
      state.truncateReason = "maxFiles";
      return;
    }
    try {
      const info = await folderIO.stat(child);
      if (info.type === "directory") {
        await walk(child, depth + 1, out, state, signal);
      } else if (/\.pdf$/i.test(child)) {
        out.push({
          path: child,
          mtime: Number(info.lastModified || 0),
          size: Number(info.size || 0) || undefined,
        });
      }
    } catch (e) {
      if ((e as Error)?.name === "RunAbortedError") throw e;
      state.incomplete = true;
      if (!state.truncateReason) state.truncateReason = "ioError";
    }
  }
}

/**
 * Build (or refresh) the folder index across all watched roots. Uses a short
 * in-memory cache; pass `force` to rescan immediately. Unchanged files (same
 * mtime) reuse their cached entry so derived data is not recomputed.
 */
export async function buildIndex(
  force = false,
  rootsOverride?: string[],
  signal?: AbortSignal | null,
): Promise<IndexedFile[]> {
  return enqueueIndexMutation(() =>
    buildIndexLocked(force, rootsOverride, signal),
  );
}

async function buildIndexLocked(
  force = false,
  rootsOverride?: string[],
  signal?: AbortSignal | null,
): Promise<IndexedFile[]> {
  const now = Date.now();
  if (!force && memCache && now - memCacheAt < 60000) return memCache;

  const roots = rootsOverride ?? getWatchRoots();
  const persisted = await loadPersisted();
  const discovered: WalkOut = [];
  const walkState: {
    incomplete: boolean;
    truncateReason: IndexTruncateReason;
  } = { incomplete: false, truncateReason: null };
  for (const root of roots) {
    if (root) await walk(root, 0, discovered, walkState, signal);
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
