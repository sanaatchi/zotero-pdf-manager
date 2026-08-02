// @ajan: cursor · @etiket: katman-2, oa-downloads, reuse-primary
/**
 * Pure helpers for P2-4: persist OA PDFs under `{watchRoot}/downloads/`.
 * Inspired by zotadata's download-to-disk discipline (AGPL-like); no Sci-Hub.
 * P1: in-process path reservation so parallel downloads cannot pick the same target.
 * Re-downloads of the same item reuse the primary path (overwrite) instead of
 * accumulating ``stem-<timestamp>.pdf`` copies.
 */

/** Paths reserved by an in-flight OA write (same process). */
const reservedPaths = new Set<string>();
let reserveChain: Promise<void> = Promise.resolve();

export function resolveOaDownloadsDir(watchRoots: string[]): string | null {
  const root = (watchRoots[0] || "").trim().replace(/[\\/]+$/, "");
  if (!root) return null;
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root}${sep}downloads`;
}

export function sanitizeDownloadBasename(raw: string): string {
  const cleaned = (raw || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (cleaned || "download").slice(0, 120);
}

export function buildOaDownloadBasename(
  fields: { doi?: string; title?: string; itemID?: number },
  sourceId = "oa",
): string {
  const doi = (fields.doi || "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const src = sanitizeDownloadBasename(sourceId);
  const id =
    typeof fields.itemID === "number" && Number.isFinite(fields.itemID)
      ? fields.itemID
      : null;
  if (doi.length > 5) {
    const stem = sanitizeDownloadBasename(doi.replace(/\//g, "_"));
    // Pin item id when present so two library items sharing a DOI still get
    // distinct paths; re-download of the same item reuses the same file.
    return id != null
      ? sanitizeDownloadBasename(`${stem}-${src}-i${id}`)
      : stem;
  }
  const title = sanitizeDownloadBasename(fields.title || "");
  const base = title || (id != null ? `item-${id}` : "item");
  // Always include item id for DOI-less names — same title + source must not
  // spawn stem-timestamp.pdf on every retry, and must not overwrite siblings.
  if (id != null) {
    return sanitizeDownloadBasename(`${base}-${src}-i${id}`);
  }
  return sanitizeDownloadBasename(`${base}-${src}`);
}

export type ReserveDownloadOpts = {
  /**
   * When true, return the primary ``stem.pdf`` even if it already exists
   * (caller will overwrite). Only unique-ify when another in-flight download
   * already reserved that path.
   */
  reuseExisting?: boolean;
};

export function uniqueDownloadPath(
  dir: string,
  basename: string,
  exists: (path: string) => boolean,
  now = Date.now(),
): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const stem = sanitizeDownloadBasename(basename);
  const candidate = `${dir}${sep}${stem}.pdf`;
  if (!exists(candidate) && !reservedPaths.has(candidate)) return candidate;
  // Deterministic first alternative (callers may still re-check async).
  return `${dir}${sep}${stem}-${now}.pdf`;
}

export function releaseDownloadPathReservation(path: string): void {
  reservedPaths.delete(path);
}

/**
 * Serialize target selection + reservation so two parallel downloads cannot
 * both pass an exists-check for the same path before either writes.
 */
export function reserveUniqueDownloadPath(
  dir: string,
  basename: string,
  existsAsync: (path: string) => Promise<boolean>,
  now = Date.now(),
  opts: ReserveDownloadOpts = {},
): Promise<string> {
  const reuseExisting = !!opts.reuseExisting;
  const run = reserveChain.then(async () => {
    const sep = dir.includes("\\") ? "\\" : "/";
    const stem = sanitizeDownloadBasename(basename);
    const tryPath = async (path: string) => {
      if (reservedPaths.has(path)) return false;
      try {
        if (await existsAsync(path)) return false;
      } catch {
        // Fail-closed: unknown existence → treat as occupied.
        return false;
      }
      reservedPaths.add(path);
      return true;
    };
    const primary = `${dir}${sep}${stem}.pdf`;
    if (reuseExisting) {
      // Re-download same item: overwrite primary instead of stem-timestamp.pdf.
      if (!reservedPaths.has(primary)) {
        reservedPaths.add(primary);
        return primary;
      }
    } else if (await tryPath(primary)) {
      return primary;
    }
    let n = now;
    for (let i = 0; i < 80; i++) {
      const alt = `${dir}${sep}${stem}-${n}.pdf`;
      if (await tryPath(alt)) return alt;
      n += 1;
    }
    const fallback = `${dir}${sep}${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.pdf`;
    reservedPaths.add(fallback);
    return fallback;
  });
  reserveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Temp sibling path for exclusive write before atomic rename into place. */
export function oaPartialTempPath(finalPath: string): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${finalPath}.partial-${stamp}`;
}

/**
 * Only delete a downloads/ final PDF if this run successfully created it.
 * Prevents cleaning up a peer process's file after a noOverwrite move failure.
 */
export function shouldCleanupPersistedDownload(
  finalCreatedByThisRun: boolean,
): boolean {
  return finalCreatedByThisRun;
}
