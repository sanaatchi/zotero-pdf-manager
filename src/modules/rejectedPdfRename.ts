// @ajan: cursor · @etiket: katman-2, rejected-rename, orphan-ready
/**
 * Rename metadata-mismatched OA downloads so orphan import can recreate a
 * Zotero item from the filename (labelled title=/author=/year= form).
 */
import { candidateFromPDFText } from "./pdfContentMetadata";
import { extractDocumentIdentifiers } from "./orphanProcessor";
import { sanitizeDownloadBasename, uniqueDownloadPath } from "./oaDownloadPath";

declare const IOUtils: any;
declare const PathUtils: any;

export type RejectedPdfHints = {
  title?: string;
  authors?: string;
  year?: string;
  doi?: string;
  isbn?: string;
};

/** Build a parseFilenameMetadata-friendly labelled stem. */
export function buildOrphanReadyBasename(
  hints: RejectedPdfHints,
  fallbackStem = "rejected-pdf",
): string {
  const parts: string[] = [];
  const title = (hints.title || "").trim();
  const authors = (hints.authors || "").trim();
  const year = (hints.year || "").match(/\b(?:18|19|20)\d{2}\b/)?.[0] || "";
  const doi = (hints.doi || "").trim();
  const isbn = (hints.isbn || "").replace(/[^0-9Xx]/g, "");

  if (title) parts.push(`title=${title}`);
  if (authors) parts.push(`author=${authors}`);
  if (year) parts.push(`year=${year}`);
  if (doi && /^10\.\d{4,9}\/\S+/i.test(doi)) parts.push(doi);
  if (isbn.length === 10 || isbn.length === 13) {
    parts.push(`ISBN ${isbn}`);
  }
  parts.push("rejected-mismatch");
  const joined = parts.length > 1 ? parts.join("__") : fallbackStem;
  return sanitizeDownloadBasename(joined).slice(0, 160) || fallbackStem;
}

export function hintsFromPdfText(pdfText: string): RejectedPdfHints {
  const text = String(pdfText || "");
  const cand = candidateFromPDFText(text);
  const ids = extractDocumentIdentifiers(text);
  const authors = cand?.authors?.length
    ? cand.authors
        .map((a) => `${a.firstName || ""} ${a.lastName || ""}`.trim())
        .filter(Boolean)
        .join("; ")
    : "";
  return {
    title: cand?.title || "",
    authors,
    year: cand?.year || "",
    doi: ids.doi || cand?.doi || "",
    isbn: ids.isbn || cand?.isbn || "",
  };
}

/**
 * Rename rejected download in place (same folder). Returns new path or original
 * on failure. Never deletes the file.
 */
export async function renameRejectedPdfOnDisk(
  persistedPath: string,
  pdfText: string,
): Promise<string> {
  const path = String(persistedPath || "").trim();
  if (!path) return path;
  try {
    if (!(await IOUtils.exists(path))) return path;
  } catch {
    return path;
  }

  const hints = hintsFromPdfText(pdfText);
  const dir = PathUtils.parent(path) as string;
  const basename = buildOrphanReadyBasename(
    hints,
    sanitizeDownloadBasename(
      (PathUtils.split(path).pop() as string)?.replace(/\.pdf$/i, "") ||
        "rejected-pdf",
    ),
  );
  const dest = uniqueDownloadPath(dir, basename, (p) => {
    // Sync exists probe is not available; treat reserved-only uniqueness.
    // Async check below.
    return p === path;
  });

  let target = dest;
  try {
    if (await IOUtils.exists(target)) {
      target = uniqueDownloadPath(dir, basename, () => true, Date.now());
    }
  } catch {
    /* keep dest */
  }

  if (
    target.replace(/\\/g, "/").toLowerCase() ===
    path.replace(/\\/g, "/").toLowerCase()
  ) {
    return path;
  }

  try {
    await IOUtils.move(path, target, { noOverwrite: true });
    return target;
  } catch (e) {
    ztoolkit.log("renameRejectedPdfOnDisk failed", path, target, e);
    return path;
  }
}
