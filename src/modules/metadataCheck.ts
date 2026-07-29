// @ajan: cursor · @etiket: katman-2, format-metadata, metadataCheck
import { PDFDocument } from "pdf-lib";
import { config } from "../../package.json";
import {
  isbnsEquivalent,
  normalizeDOI,
  normalizeISBNDigits,
  normalizePagesConnector,
  stripTitleTrailingDot,
} from "../utils/metadataNormalize";
import { getPref } from "../utils/prefs";

declare const IOUtils: any;

export type CheckMetadata = {
  title?: string;
  creators?: string[];
  year?: string;
  doi?: string;
  isbn?: string;
  evidence?: string;
};

export type MetadataCheckResult = {
  status: "match" | "warning" | "mismatch";
  score: number;
  details: string[];
};

function normalize(value: string) {
  return (value || "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(value: string) {
  return new Set(
    normalize(value)
      .split(/\s+/)
      .filter((token) => token.length > 1),
  );
}

function similarity(left: string, right: string) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common++;
  return common / new Set([...a, ...b]).size;
}

function containment(needle: string, haystack: string) {
  const expected = tokens(needle);
  const actual = tokens(haystack);
  if (!expected.size || !actual.size) return 0;
  let common = 0;
  for (const token of expected) if (actual.has(token)) common++;
  return common / expected.size;
}

function cleanDOI(value: string) {
  return normalizeDOI(value);
}

function cleanISBN(value: string) {
  // Prefer a checksum-valid candidate when several digit runs appear.
  const candidates =
    value.match(/(?:97[89][\d -]{10,16}|\d[\d xX-]{8,16})/g) || [];
  for (const candidate of candidates) {
    const normalized = normalizeISBNDigits(candidate);
    if (normalized.length === 10 || normalized.length === 13) return normalized;
  }
  return "";
}

export function compareMetadata(
  zotero: CheckMetadata,
  pdf: CheckMetadata,
): MetadataCheckResult {
  const details: string[] = [];
  let points = 0;
  let possible = 0;
  let criticalMismatch = false;
  let warning = false;

  const contentEvidence = pdf.evidence || "";
  const zoteroDOI = cleanDOI(zotero.doi || "");
  const pdfDOI = cleanDOI(`${pdf.doi || ""}\n${contentEvidence}`);
  if (zoteroDOI && pdfDOI) {
    possible += 4;
    if (zoteroDOI === pdfDOI) {
      points += 4;
      details.push("DOI eşleşiyor");
    } else {
      criticalMismatch = true;
      details.push(`DOI uyuşmuyor: Zotero=${zoteroDOI}, PDF=${pdfDOI}`);
    }
  }

  const zoteroISBN = cleanISBN(zotero.isbn || "");
  const pdfISBN = cleanISBN(`${pdf.isbn || ""}\n${contentEvidence}`);
  if (zoteroISBN && pdfISBN) {
    possible += 4;
    if (isbnsEquivalent(zoteroISBN, pdfISBN)) {
      points += 4;
      details.push(
        zoteroISBN === pdfISBN ? "ISBN eşleşiyor" : "ISBN eşleşiyor (10↔13)",
      );
    } else {
      criticalMismatch = true;
      details.push(`ISBN uyuşmuyor: Zotero=${zoteroISBN}, PDF=${pdfISBN}`);
    }
  }

  const zoteroTitle = stripTitleTrailingDot(zotero.title || "");
  if (zoteroTitle && (pdf.title || contentEvidence)) {
    possible += 3;
    const metadataTitleScore = pdf.title
      ? similarity(zoteroTitle, stripTitleTrailingDot(pdf.title))
      : 0;
    const contentTitleScore = contentEvidence
      ? containment(zoteroTitle, contentEvidence)
      : 0;
    const titleScore = Math.max(metadataTitleScore, contentTitleScore);
    points += 3 * titleScore;
    if (titleScore >= 0.55) {
      details.push(
        metadataTitleScore >= contentTitleScore
          ? "Başlık metadata alanında eşleşiyor"
          : "Başlık PDF içeriğinde eşleşiyor",
      );
    } else {
      criticalMismatch = true;
      details.push(
        `Başlık benzerliği düşük (${Math.round(titleScore * 100)}%)`,
      );
    }
  } else {
    warning = true;
    details.push("PDF başlık metadata alanı eksik");
  }

  const creatorEvidence = normalize(
    `${(pdf.creators || []).join(" ")} ${contentEvidence}`,
  );
  const zoteroCreators = (zotero.creators || [])
    .map((name) => normalize(name).split(" ").at(-1) || "")
    .filter(Boolean);
  if (zoteroCreators.length && creatorEvidence) {
    possible += 2;
    if (zoteroCreators.some((name) => creatorEvidence.includes(name))) {
      points += 2;
      details.push("Yazar/editör eşleşiyor");
    } else {
      warning = true;
      details.push("Yazar/editör uyuşmuyor");
    }
  } else {
    warning = true;
    details.push("PDF yazar metadata alanı eksik");
  }

  const evidenceYear =
    pdf.year || contentEvidence.match(/\b(?:18|19|20)\d{2}\b/)?.[0] || "";
  if (zotero.year && evidenceYear) {
    possible += 1;
    if (zotero.year === evidenceYear) {
      points += 1;
      details.push("Yıl eşleşiyor");
    } else {
      warning = true;
      details.push(`Yıl uyuşmuyor: Zotero=${zotero.year}, PDF=${evidenceYear}`);
    }
  }

  const score = possible ? Math.round((points / possible) * 100) : 0;
  return {
    status: criticalMismatch ? "mismatch" : warning ? "warning" : "match",
    score,
    details,
  };
}

export function itemCheckMetadata(item: Zotero.Item): CheckMetadata {
  const creators = (((item as any).getCreators?.() || []) as any[])
    .map(
      (creator) =>
        creator.name ||
        [creator.firstName, creator.lastName].filter(Boolean).join(" "),
    )
    .filter(Boolean);
  return {
    title: String(item.getField("title") || item.getDisplayTitle() || ""),
    creators,
    year: String(item.getField("date") || "").match(/\b\d{4}\b/)?.[0] || "",
    doi: String(item.getField("DOI") || ""),
    isbn: String(item.getField("ISBN") || ""),
  };
}

/** Compare a Zotero item against raw PDF / fulltext evidence. */
export function compareItemAgainstText(
  item: Zotero.Item,
  text: string,
): MetadataCheckResult {
  return compareMetadata(itemCheckMetadata(item), { evidence: text });
}

export function hasIdentifierConflict(result: MetadataCheckResult): boolean {
  return result.details.some(
    (d) => d.includes("DOI uyuşmuyor") || d.includes("ISBN uyuşmuyor"),
  );
}

export function hasIdentifierMatch(result: MetadataCheckResult): boolean {
  return result.details.some(
    (d) => d.startsWith("DOI eşleşiyor") || d.startsWith("ISBN eşleşiyor"),
  );
}

/**
 * Light in-place fixes from format-metadata (DOI prefix, pages connector,
 * title trailing dot). Gated by pdf.metadataCheck.
 */
export async function normalizeItemIdentifiers(
  item: Zotero.Item,
): Promise<string[]> {
  if (!getPref("pdf.metadataCheck")) return [];
  const applied: string[] = [];
  let dirty = false;

  const rawDoi = String(item.getField("DOI") || "");
  const cleaned = normalizeDOI(rawDoi);
  if (cleaned && cleaned !== rawDoi.trim()) {
    item.setField("DOI", cleaned);
    applied.push("doi-prefix");
    dirty = true;
  }

  try {
    const pages = String(item.getField("pages") || "");
    const fixedPages = normalizePagesConnector(pages);
    if (pages && fixedPages !== pages) {
      item.setField("pages", fixedPages);
      applied.push("pages-connector");
      dirty = true;
    }
  } catch {
    /* item type may lack pages */
  }

  const title = String(item.getField("title") || "");
  const fixedTitle = stripTitleTrailingDot(title);
  if (title && fixedTitle !== title) {
    item.setField("title", fixedTitle);
    applied.push("title-trailing-dot");
    dirty = true;
  }

  if (dirty) {
    try {
      await item.saveTx();
    } catch (e) {
      ztoolkit.log("normalizeItemIdentifiers save failed", e);
    }
  }
  return applied;
}

/** Pure so the encrypted-PDF branch below is unit-testable without a real encrypted file. */
export function isEncryptedPdfError(error: unknown): boolean {
  const message = (error as Error)?.message || String(error);
  return /encrypt/i.test(message);
}

async function pdfMetadata(attachment: Zotero.Item): Promise<CheckMetadata> {
  const path = await attachment.getFilePathAsync();
  if (!path || !(await IOUtils.exists(path))) {
    throw new Error("PDF dosyası bulunamadı");
  }
  // IOUtils returns a typed array from Zotero's privileged JS compartment.
  // pdf-lib rejects cross-compartment Uint8Arrays, so copy it into this
  // extension's realm before parsing.
  const rawBytes = await IOUtils.read(path);
  const bytes = Uint8Array.from(rawBytes as ArrayLike<number>);
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: false,
    });
  } catch (error) {
    if (isEncryptedPdfError(error)) {
      throw new Error("Şifreli PDF: metadata okunamadı");
    }
    throw error;
  }
  const title = pdf.getTitle() || "";
  const author = pdf.getAuthor() || "";
  const subject = pdf.getSubject() || "";
  const keywords = pdf.getKeywords() || "";
  const indexedText = await readIndexedPDFText(attachment);
  const evidence = [
    title,
    author,
    subject,
    keywords,
    attachment.attachmentFilename,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    title,
    creators: author ? author.split(/[;,]/).map((name) => name.trim()) : [],
    year:
      `${evidence}\n${indexedText}`.match(/\b(?:18|19|20)\d{2}\b/)?.[0] || "",
    doi: cleanDOI(`${evidence}\n${indexedText}`),
    isbn: cleanISBN(`${evidence}\n${indexedText}`),
    evidence: indexedText,
  };
}

async function readIndexedPDFText(attachment: Zotero.Item) {
  const fulltext = Zotero.Fulltext as any;
  const getCachePath = () => {
    try {
      return fulltext.getItemCacheFile(attachment)?.path as string | undefined;
    } catch (_e) {
      return undefined;
    }
  };
  let cachePath = getCachePath();
  if (!cachePath || !(await IOUtils.exists(cachePath))) {
    try {
      await fulltext.indexItems([attachment.id], {
        complete: false,
        ignoreErrors: true,
      });
    } catch (error) {
      ztoolkit.log("PDF content indexing failed", attachment.id, error);
    }
    cachePath = getCachePath();
  }
  if (!cachePath || !(await IOUtils.exists(cachePath))) return "";
  try {
    const text = await Zotero.File.getContentsAsync(cachePath);
    return String(text || "").slice(0, 100_000);
  } catch (error) {
    ztoolkit.log("PDF indexed text could not be read", attachment.id, error);
    return "";
  }
}

export async function checkMetadataForSelectedItems() {
  const pairs = new Map<
    number,
    { item: Zotero.Item; attachment: Zotero.Item }
  >();
  for (const selected of ZoteroPane.getSelectedItems()) {
    if (selected.isAttachment() && selected.parentItemID) {
      const parent =
        selected.parentItem || Zotero.Items.get(selected.parentItemID);
      if (parent?.isRegularItem()) {
        pairs.set(selected.id, { item: parent, attachment: selected });
      }
    } else if (selected.isRegularItem()) {
      for (const id of selected.getAttachments()) {
        const attachment = Zotero.Items.get(id);
        if (attachment?.attachmentContentType === "application/pdf") {
          pairs.set(id, { item: selected, attachment });
        }
      }
    }
  }

  if (!pairs.size) {
    window.alert("Metadata kontrolü için PDF eki olan bir kayıt seçin.");
    return;
  }

  const reports: string[] = [];
  for (const { item, attachment } of pairs.values()) {
    try {
      const normalized = await normalizeItemIdentifiers(item);
      const extracted = await pdfMetadata(attachment);
      const result = compareMetadata(itemCheckMetadata(item), extracted);
      if (normalized.length) {
        result.details.unshift(`Normalize: ${normalized.join(", ")}`);
      }
      if (!extracted.evidence) {
        result.details.unshift(
          "PDF metin katmanı bulunamadı; taranmış belge için OCR gerekli olabilir",
        );
      }
      const symbol =
        result.status === "match"
          ? "✓"
          : result.status === "warning"
            ? "⚠"
            : "✗";
      reports.push(
        `${symbol} ${item.getDisplayTitle()} — %${result.score}\n  ${result.details.join("; ")}`,
      );
    } catch (error) {
      reports.push(
        `✗ ${item.getDisplayTitle()} — ${(error as Error).message || error}`,
      );
    }
  }
  window.alert(
    `${config.addonName} — Metadata kontrolü\n\n${reports.join("\n\n")}`,
  );
}
