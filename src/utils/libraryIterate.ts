// @ajan: cursor · @etiket: katman-2, p2, library-iterate, scale, generator
/**
 * Bounded-batch iteration over a Zotero library to avoid loading up to
 * MAX_LIBRARY_PDFS (99999) items into memory in one shot during reconcile.
 */

export const DEFAULT_LIBRARY_BATCH_SIZE = 250;
export const MAX_LIBRARY_BATCH_SIZE = 2000;

export type LibraryItemLoader = {
  getAllIDs?: (libraryID: number) => Promise<number[]> | number[];
  getAsync?: (
    ids: number[],
  ) => Promise<Zotero.Item[] | Zotero.Item | false | null>;
  getAll?: (
    libraryID: number,
    onlyTopLevel?: boolean,
    includeDeleted?: boolean,
  ) => Promise<Zotero.Item[]>;
};

export function normalizeLibraryBatchSize(value: unknown): number {
  const n =
    typeof value === "number" ? value : Number.parseInt(`${value ?? ""}`, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIBRARY_BATCH_SIZE;
  return Math.min(MAX_LIBRARY_BATCH_SIZE, Math.floor(n));
}

/** Streaming ID chunks — does not allocate the full chunk matrix up front. */
export function* iterIdChunks(
  ids: number[],
  batchSize: number,
): Generator<number[], void, undefined> {
  const size = normalizeLibraryBatchSize(batchSize);
  for (let i = 0; i < ids.length; i += size) {
    yield ids.slice(i, i + size);
  }
}

/** Materialize chunks (tests / callers that need an array). */
export function chunkIds(ids: number[], batchSize: number): number[][] {
  return Array.from(iterIdChunks(ids, batchSize));
}

function defaultLoader(): LibraryItemLoader {
  return {
    getAllIDs: (libraryID) => (Zotero.Items as any).getAllIDs?.(libraryID),
    getAsync: (ids) => (Zotero.Items as any).getAsync(ids),
    getAll: (libraryID, onlyTopLevel, includeDeleted) =>
      (Zotero.Items as any).getAll(libraryID, onlyTopLevel, includeDeleted),
  };
}

/**
 * Yield regular-item batches. Prefers getAllIDs + getAsync.
 * Full getAll fallback is opt-in (`allowGetAllFallback`) — large libraries
 * fail closed with zero batches when getAllIDs is unavailable.
 */
export async function* iterateLibraryItemBatches(
  libraryID: number,
  opts: {
    batchSize?: number;
    signal?: AbortSignal | null;
    onlyTopLevel?: boolean;
    loader?: LibraryItemLoader;
    yieldEventLoop?: () => Promise<void>;
    allowGetAllFallback?: boolean;
  } = {},
): AsyncGenerator<Zotero.Item[], void, undefined> {
  const batchSize = normalizeLibraryBatchSize(opts.batchSize);
  const loader = opts.loader || defaultLoader();
  const yieldEventLoop =
    opts.yieldEventLoop || (() => new Promise<void>((r) => setTimeout(r, 0)));

  let ids: number[] | null = null;
  if (typeof loader.getAllIDs === "function") {
    try {
      if (opts.signal?.aborted) return;
      const raw = await loader.getAllIDs(libraryID);
      if (opts.signal?.aborted) return;
      if (Array.isArray(raw)) ids = raw.map(Number).filter(Number.isFinite);
    } catch {
      ids = null;
    }
  }

  if (ids) {
    for (const chunk of iterIdChunks(ids, batchSize)) {
      if (opts.signal?.aborted) return;
      if (!chunk.length) continue;
      let items: Zotero.Item[] = [];
      if (typeof loader.getAsync === "function") {
        const loaded = await loader.getAsync(chunk);
        if (opts.signal?.aborted) return;
        if (Array.isArray(loaded)) {
          items = loaded.filter(Boolean) as Zotero.Item[];
        } else if (loaded) {
          items = [loaded as Zotero.Item];
        }
      }
      if (opts.onlyTopLevel !== false) {
        items = items.filter(
          (item) =>
            item &&
            typeof item.isRegularItem === "function" &&
            item.isRegularItem() &&
            (!(item as any).isTopLevelItem || (item as any).isTopLevelItem()),
        );
      }
      if (items.length) yield items;
      await yieldEventLoop();
    }
    return;
  }

  if (opts.allowGetAllFallback !== true) return;
  if (typeof loader.getAll !== "function") return;
  if (opts.signal?.aborted) return;
  const all = (await loader.getAll(
    libraryID,
    opts.onlyTopLevel !== false,
    false,
  )) as Zotero.Item[];
  for (const chunk of iterIdChunks(
    all.map((item) => item.id),
    batchSize,
  )) {
    if (opts.signal?.aborted) return;
    const set = new Set(chunk);
    yield all.filter((item) => set.has(item.id));
    await yieldEventLoop();
  }
}
