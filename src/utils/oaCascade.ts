// @ajan: cursor · @etiket: katman-2, p2, oa-cascade, content-mismatch-continue
/**
 * Pure automatic OA cascade loop (no Zotero globals).
 * Stops on AttachStoppedError / RunAbortedError; skips once hasPDF is true.
 * ContentMismatchError is soft-fail via onSourceError — cascade continues.
 */

export type CascadeSourceLike = {
  id: string;
  isEnabled: () => boolean;
  supportsItem: (item: unknown) => boolean;
  tryAttach: (item: unknown) => Promise<unknown | null>;
};

export type CascadeStoppedResult = {
  stopped: "review" | "erase-failed" | string;
  attachment?: unknown | null;
};

export type CascadeSuccessResult = {
  attachment: unknown;
  source: string;
  stopped?: undefined;
};

export type CascadeResult = CascadeSuccessResult | CascadeStoppedResult;

function isAttachStopped(e: unknown): e is {
  name: string;
  reason: string;
  attachment?: unknown;
} {
  return !!(e && (e as Error).name === "AttachStoppedError");
}

function isRunAborted(e: unknown): boolean {
  return !!(e && (e as Error).name === "RunAbortedError");
}

export async function cascadeAutomaticSources(
  item: unknown,
  sources: CascadeSourceLike[],
  opts: {
    hasPDF: (item: unknown) => boolean;
    throwIfAborted?: () => void;
    afterAttach?: (
      item: unknown,
      attachment: unknown,
      sourceId: string,
    ) => Promise<unknown>;
    onSourceError?: (sourceId: string, error: unknown) => void;
  },
): Promise<CascadeResult | null> {
  opts.throwIfAborted?.();
  if (opts.hasPDF(item)) return null;

  for (const source of sources) {
    const id = source.id;
    opts.throwIfAborted?.();
    if (opts.hasPDF(item)) return null;
    if (!source.isEnabled() || !source.supportsItem(item)) continue;
    try {
      let attachment = await source.tryAttach(item);
      opts.throwIfAborted?.();
      if (!attachment) continue;
      if (opts.afterAttach) {
        attachment = await opts.afterAttach(item, attachment, id);
      }
      return { attachment, source: id };
    } catch (e) {
      if (isRunAborted(e)) throw e;
      if (isAttachStopped(e)) {
        return { stopped: e.reason, attachment: e.attachment };
      }
      opts.onSourceError?.(id, e);
    }
  }
  return null;
}
