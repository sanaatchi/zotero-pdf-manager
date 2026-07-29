// @ajan: cursor · @etiket: katman-2, p2, orphan, bounded-memory, p2-5
import { IndexedFile } from "./folderIndex";
import { appendAuditEvent } from "./automationAudit";
import {
  applyFilenameMetadata,
  parseFilenameMetadata,
  parseThesisCoverText,
  thesisCoverMetadataFromAttachment,
  yokThesisNumber,
} from "./filenameMetadata";

export { parseThesisCoverText, yokThesisNumber } from "./filenameMetadata";

declare const IOUtils: any;

const SOURCE_PATH_PREFIX = "ZPDF-Source-Path:";
const YOK_TEZ_NUMBER_PREFIX = "YÖK Tez No:";

export type OrphanMode = "report" | "autoCreate" | "off";
export type OrphanSource = "automatic" | "manual";

export interface OrphanStats {
  found: number;
  created: number;
  planned: number;
  failed: number;
  skipped: number;
}

/** Safe default is report — unknown values never escalate to autoCreate. */
export function normalizeOrphanMode(value: unknown): OrphanMode {
  const mode = String(value ?? "")
    .trim()
    .toLowerCase();
  if (mode === "autocreate") return "autoCreate";
  if (mode === "off") return "off";
  if (mode === "report") return "report";
  return "report";
}

/**
 * Automatic periodic/startup autoCreate only when an identifier anchors the
 * new item (watch-folder safety: no blind filename-only mass create).
 * Manual button may create filename-titled drafts.
 */
export function shouldAutoCreateOrphan(
  mode: OrphanMode,
  source: OrphanSource,
  anchors: { doi?: string; isbn?: string; thesisNumber?: string },
): boolean {
  if (mode !== "autoCreate") return false;
  if (source === "manual") return true;
  return Boolean(
    (anchors.doi && anchors.doi.length > 5) ||
    (anchors.isbn &&
      (anchors.isbn.length === 10 || anchors.isbn.length === 13)) ||
    (anchors.thesisNumber && /^\d{5,}$/.test(anchors.thesisNumber)),
  );
}

export function normalizeOrphanTitle(filename: string): string {
  return filename
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*[-–—]\s*/g, " — ")
    .trim();
}

export function extractDocumentIdentifiers(text: string) {
  const doi =
    text
      .match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i)?.[0]
      ?.replace(/[).,;]+$/, "") || "";
  const isbn =
    text
      .match(
        /\b(?:ISBN(?:-1[03])?\s*:?\s*)?((?:97[89][\s-]?)?\d[\d\s-]{8,16}\d|(?:97[89][\s-]?)?[\dX][\dX\s-]{8,16}[\dX])\b/i,
      )?.[1]
      ?.replace(/[\s-]/g, "") || "";
  const validISBN = (value: string) => {
    if (/^\d{13}$/.test(value)) {
      const sum = value
        .slice(0, 12)
        .split("")
        .reduce(
          (total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1),
          0,
        );
      return (10 - (sum % 10)) % 10 === Number(value[12]);
    }
    if (/^\d{9}[\dX]$/i.test(value)) {
      const sum = value.split("").reduce((total, digit, index) => {
        const number = digit.toUpperCase() === "X" ? 10 : Number(digit);
        return total + number * (10 - index);
      }, 0);
      return sum % 11 === 0;
    }
    return false;
  };
  return {
    doi,
    isbn: validISBN(isbn) ? isbn : "",
  };
}

function canonicalPath(path: string) {
  return path.replace(/\//g, "\\").toLocaleLowerCase();
}

function orphanTitleTokens(value: string): Set<string> {
  return new Set(
    (value || "")
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

/**
 * Whether a Crossref title plausibly matches the filename-derived title.
 * Guards against a reference DOI (found deep in the PDF body) fetching a
 * completely different paper's metadata. Returns true when either title is
 * empty (nothing to compare → don't block).
 */
function titlesRoughlyMatch(a: string, b: string): boolean {
  const ta = orphanTitleTokens(a);
  const tb = orphanTitleTokens(b);
  if (!ta.size || !tb.size) return true;
  let common = 0;
  for (const token of ta) if (tb.has(token)) common++;
  return common / Math.min(ta.size, tb.size) >= 0.4;
}

async function identifiersFromPDF(path: string) {
  try {
    const bytes = (await IOUtils.read(path, {
      maxBytes: 2 * 1024 * 1024,
    })) as Uint8Array;
    // DOI/ISBN strings are commonly present in the PDF metadata or first
    // objects even when the page content itself is compressed.
    const text = new TextDecoder("latin1").decode(bytes);
    return extractDocumentIdentifiers(text);
  } catch (e) {
    ztoolkit.log("Could not inspect orphan PDF identifiers", path, e);
    return { doi: "", isbn: "" };
  }
}

async function crossrefMetadata(doi: string): Promise<any | null> {
  if (!doi) return null;
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const response = await (Zotero.HTTP as any).request("GET", url, {
      responseType: "json",
      timeout: 30000,
      successCodes: [200],
    });
    const body =
      response.response ??
      (response.responseText ? JSON.parse(response.responseText) : null);
    return body?.message || null;
  } catch (e) {
    ztoolkit.log("Crossref orphan lookup failed", doi, e);
    return null;
  }
}

function safeSetField(item: Zotero.Item, field: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  try {
    (item as any).setField(field, String(value));
  } catch {
    // Crossref fields vary across Zotero item types; unsupported fields are
    // intentionally ignored instead of aborting the orphan import.
  }
}

async function createItemForFile(
  file: IndexedFile,
  libraryID: number,
): Promise<Zotero.Item | null> {
  const filenameMetadata = parseFilenameMetadata(file.name);
  const thesisNumber = yokThesisNumber(file.name);
  if (thesisNumber) filenameMetadata.itemType = "thesis";
  const identifiers = await identifiersFromPDF(file.path);
  const doi = identifiers.doi || filenameMetadata.doi || file.doi || "";
  const isbn = identifiers.isbn || filenameMetadata.isbn || file.isbn || "";
  const rawMetadata = await crossrefMetadata(doi);
  // Only trust Crossref if its title plausibly matches the filename — a DOI
  // scraped from the PDF body may belong to a cited work, not this document.
  const filenameTitle =
    filenameMetadata.title || normalizeOrphanTitle(file.name);
  const metadata =
    rawMetadata &&
    titlesRoughlyMatch(rawMetadata.title?.[0] || "", filenameTitle)
      ? rawMetadata
      : null;
  if (rawMetadata && !metadata) {
    ztoolkit.log(
      "Orphan: Crossref title mismatch — ignoring DOI metadata",
      file.path,
    );
  }
  const itemType = metadata
    ? "journalArticle"
    : filenameMetadata.itemType === "document" && isbn
      ? "book"
      : filenameMetadata.itemType || "document";
  const item = new Zotero.Item(itemType as any);
  (item as any).libraryID = libraryID;

  // Filename metadata is applied before the first save. More authoritative
  // Crossref/PDF identifiers below may refine these initial values.
  applyFilenameMetadata(item, filenameMetadata);
  const title =
    metadata?.title?.[0] ||
    filenameMetadata.title ||
    normalizeOrphanTitle(file.name) ||
    "Untitled PDF";
  safeSetField(item, "title", title);
  // When Crossref was rejected, do not persist the unvalidated body DOI —
  // only a Crossref-confirmed or filename DOI is trustworthy.
  safeSetField(item, "DOI", metadata?.DOI || filenameMetadata.doi || "");
  safeSetField(item, "ISBN", isbn);
  safeSetField(item, "publicationTitle", metadata?.["container-title"]?.[0]);
  safeSetField(item, "volume", metadata?.volume);
  safeSetField(item, "issue", metadata?.issue);
  safeSetField(item, "pages", metadata?.page);
  safeSetField(item, "url", metadata?.URL);
  safeSetField(
    item,
    "date",
    metadata?.issued?.["date-parts"]?.[0]?.filter(Boolean).join("-"),
  );
  safeSetField(
    item,
    "extra",
    [
      `${SOURCE_PATH_PREFIX} ${file.path}`,
      `ZPDF-Original-Filename: ${file.name}`,
      `ZPDF-Original-Title: ${normalizeOrphanTitle(file.name)}`,
      ...(thesisNumber ? [`${YOK_TEZ_NUMBER_PREFIX} ${thesisNumber}`] : []),
    ].join("\n"),
  );
  if (Array.isArray(metadata?.author)) {
    item.setCreators(
      metadata.author.map((author: any) => ({
        firstName: author.given || "",
        lastName: author.family || author.name || "",
        creatorType: "author",
      })),
    );
  }
  item.addTag("#auto-created");
  item.addTag("#pdf-orphan");
  if (
    filenameMetadata.title ||
    filenameMetadata.authors?.length ||
    filenameMetadata.year ||
    filenameMetadata.publisher ||
    filenameMetadata.publicationTitle
  ) {
    item.addTag("#filename-metadata");
  }

  try {
    await item.saveTx();
    const attachment = await (Zotero.Attachments as any).linkFromFile({
      file: file.path,
      libraryID,
      parentItemID: item.id,
      title: "PDF",
      contentType: "application/pdf",
    });
    if (!attachment) throw new Error("Linked attachment was not created");
    if (thesisNumber) {
      const coverMetadata = await thesisCoverMetadataFromAttachment(attachment);
      applyFilenameMetadata(item, coverMetadata);
      safeSetField(item, "title", coverMetadata.title);
      if (coverMetadata.authors?.length) {
        item.setCreators(
          coverMetadata.authors.map((name) => ({
            firstName: name.split(/\s+/).slice(0, -1).join(" "),
            lastName: name.split(/\s+/).at(-1) || name,
            creatorType: "author",
          })),
        );
      }
      if (
        coverMetadata.title ||
        coverMetadata.authors?.length ||
        coverMetadata.university ||
        coverMetadata.year
      ) {
        item.addTag("#pdf-cover-metadata");
      }
      await item.saveTx();
    }
    return item;
  } catch (e) {
    ztoolkit.log("Orphan item creation failed", file.path, e);
    if (item.id) {
      try {
        await item.eraseTx();
      } catch {
        // Best-effort rollback.
      }
    }
    return null;
  }
}

export async function mergeKnownSourcePaths(
  items: Zotero.Item[],
  into: Set<string> = new Set(),
): Promise<Set<string>> {
  for (const item of items) {
    try {
      const extra = String(item.getField("extra") || "");
      for (const line of extra.split(/\r?\n/)) {
        if (line.startsWith(SOURCE_PATH_PREFIX)) {
          into.add(canonicalPath(line.slice(SOURCE_PATH_PREFIX.length).trim()));
        }
      }
      for (const attachmentID of item.getAttachments()) {
        const attachment = Zotero.Items.get(attachmentID);
        const path = await attachment?.getFilePathAsync?.();
        if (path) into.add(canonicalPath(path));
      }
    } catch {
      // Ignore a malformed/deleted item and continue the audit.
    }
  }
  return into;
}

async function knownSourcePaths(items: Zotero.Item[]) {
  return mergeKnownSourcePaths(items);
}

export async function processOrphanPDFs(
  files: IndexedFile[],
  itemsOrKnown: Zotero.Item[] | Set<string>,
  libraryID: number,
  mode: string,
  limit: number,
  dryRun = false,
  run = "manual",
  source: OrphanSource = "manual",
): Promise<OrphanStats> {
  const stats: OrphanStats = {
    found: 0,
    created: 0,
    planned: 0,
    failed: 0,
    skipped: 0,
  };
  const orphanMode = normalizeOrphanMode(mode);
  if (orphanMode === "off") return stats;

  const known =
    itemsOrKnown instanceof Set
      ? itemsOrKnown
      : await knownSourcePaths(itemsOrKnown);
  const orphans = files.filter((file) => !known.has(canonicalPath(file.path)));
  stats.found = orphans.length;

  if (orphanMode !== "autoCreate") {
    ztoolkit.log(`Orphan PDF report: ${orphans.length} file(s)`);
    if (orphans.length) {
      await appendAuditEvent({
        run,
        action: "orphan-report",
        outcome: "info",
        detail: `${orphans.length} orphan PDF(s); mode=${orphanMode}`,
      });
    }
    return stats;
  }

  const boundedLimit = Math.max(0, Math.min(100, Math.floor(limit) || 10));
  for (const file of orphans.slice(0, boundedLimit)) {
    const thesisNumber = yokThesisNumber(file.name);
    let doi = file.doi || "";
    let isbn = file.isbn || "";
    if (
      source === "automatic" &&
      !shouldAutoCreateOrphan(orphanMode, source, {
        doi,
        isbn,
        thesisNumber: thesisNumber || undefined,
      })
    ) {
      const peeked = await identifiersFromPDF(file.path);
      doi = peeked.doi || doi;
      isbn = peeked.isbn || isbn;
    }
    if (
      !shouldAutoCreateOrphan(orphanMode, source, {
        doi,
        isbn,
        thesisNumber: thesisNumber || undefined,
      })
    ) {
      stats.skipped++;
      await appendAuditEvent({
        run,
        action: "orphan-skip",
        outcome: "review",
        path: file.path,
        title: normalizeOrphanTitle(file.name),
        detail: "Automatic autoCreate requires DOI, ISBN, or YÖK thesis number",
      });
      continue;
    }

    if (dryRun) {
      stats.planned++;
      await appendAuditEvent({
        run,
        action: "orphan-create",
        outcome: "planned",
        path: file.path,
        title: normalizeOrphanTitle(file.name),
        detail: "Dry-run: item and linked attachment were not created",
      });
      continue;
    }
    const created = await createItemForFile(file, libraryID);
    if (created) {
      stats.created++;
      await appendAuditEvent({
        run,
        action: "orphan-create",
        outcome: "success",
        itemID: created.id,
        title: String(created.getField("title") || file.name),
        path: file.path,
        detail: "Tagged #auto-created and #pdf-orphan",
      });
    } else {
      stats.failed++;
      await appendAuditEvent({
        run,
        action: "orphan-create",
        outcome: "failed",
        path: file.path,
      });
    }
  }
  return stats;
}
