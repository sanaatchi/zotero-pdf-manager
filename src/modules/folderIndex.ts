import { getPref } from "../utils/prefs";

// Gecko globals available in the Zotero sandbox but not in the type defs.
declare const IOUtils: any;
declare const PathUtils: any;

/**
 * A persistent, incremental, multi-root index of the PDF files found under the
 * user's watched folders. This is the foundation of full automation:
 *
 * - **Multi-root:** watches a LIST of roots (set once), recursively. New
 *   sub-folders/files are picked up automatically — no path maintenance.
 * - **Persistent:** the index is cached to disk, so it survives restarts and
 *   is available instantly.
 * - **Incremental:** on rebuild, files whose mtime is unchanged reuse their
 *   cached derived data; only new/changed files are reprocessed. This is what
 *   makes future PDF-metadata extraction (DOI/ISBN from the file) affordable.
 */
export interface IndexedFile {
  path: string;
  mtime: number;
  name: string; // file name without extension
  norm: string; // normalized name (NFKD + mark strip + lowercase), for matching
  alnum: string; // lowercased alphanumeric of the name, for DOI/ISBN matching
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

/** The list of watched roots (set once). Falls back to the legacy single folder. */
export function getWatchRoots(): string[] {
  const raw = ((getPref("pdf.watchRoots") as string) || "").trim();
  const roots = parseWatchRoots(raw);
  if (!roots.length) {
    const legacy = ((getPref("pdf.localFolder") as string) || "").trim();
    if (legacy) return parseWatchRoots(legacy);
  }
  return roots;
}

async function loadPersisted(): Promise<Map<string, IndexedFile>> {
  const map = new Map<string, IndexedFile>();
  try {
    const p = indexFilePath();
    if (await IOUtils.exists(p)) {
      const arr = JSON.parse(await IOUtils.readUTF8(p)) as unknown;
      if (!Array.isArray(arr)) return map;
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
        }
      }
    }
  } catch (e) {
    ztoolkit.log("Folder index load failed", e);
  }
  return map;
}

async function persist(files: IndexedFile[]): Promise<void> {
  try {
    await IOUtils.writeUTF8(indexFilePath(), JSON.stringify(files));
  } catch (e) {
    ztoolkit.log("Folder index persist failed", e);
  }
}

async function walk(
  dir: string,
  depth: number,
  out: { path: string; mtime: number }[],
): Promise<void> {
  if (depth > 8 || out.length >= 50000) return;
  let children: string[] = [];
  try {
    children = await IOUtils.getChildren(dir);
  } catch {
    return; // unreadable folder
  }
  for (const child of children) {
    try {
      const info = await IOUtils.stat(child);
      if (info.type === "directory") {
        await walk(child, depth + 1, out);
      } else if (/\.pdf$/i.test(child)) {
        out.push({ path: child, mtime: Number(info.lastModified || 0) });
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
  const now = Date.now();
  if (!force && memCache && now - memCacheAt < 60000) return memCache;

  const roots = getWatchRoots();
  const persisted = await loadPersisted();
  const discovered: { path: string; mtime: number }[] = [];
  for (const root of roots) {
    if (root) await walk(root, 0, discovered);
  }

  // A child root may also be contained by another configured root. Keep one
  // entry per path so matching never sees artificial duplicates.
  const unique = new Map<string, { path: string; mtime: number }>();
  for (const file of discovered) {
    unique.set(file.path.toLocaleLowerCase(), file);
  }

  const index: IndexedFile[] = Array.from(unique.values()).map((d) => {
    const prev = persisted.get(d.path);
    if (prev && prev.mtime === d.mtime) return prev; // unchanged → reuse
    const name = d.path.replace(/^.*[\\/]/, "").replace(/\.pdf$/i, "");
    return {
      path: d.path,
      mtime: d.mtime,
      name,
      norm: normalize(name),
      alnum: name.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    };
  });

  memCache = index;
  memCacheAt = now;
  await persist(index);
  ztoolkit.log(
    `Folder index: ${index.length} PDFs across ${roots.length} root(s)`,
  );
  return index;
}

/** Drop the in-memory cache so the next buildIndex() rescans. */
export function invalidateIndex(): void {
  memCache = null;
  memCacheAt = 0;
}
