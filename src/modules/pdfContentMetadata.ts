import { PDFDocument } from "pdf-lib";
import { config } from "../../package.json";
import { extractDocumentIdentifiers } from "./orphanProcessor";

declare const IOUtils: any;

type Candidate = {
  source: "Crossref" | "Open Library" | "PDF content";
  itemType: string;
  title: string;
  authors: Array<{ firstName: string; lastName: string }>;
  year: string;
  publisher: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  isbn?: string;
  url?: string;
};

export function repairTurkishPDFText(value: string) {
  return String(value || "")
    .replace(/G\u0307/g, "İ")
    .replace(/(\p{Lu})g\u0307(?=\p{Lu})/gu, "$1Ş")
    .replace(/g\u0307/g, "ş")
    .replace(/G\u0327/g, "Ş")
    .replace(/g\u0327/g, "ş")
    .normalize("NFC");
}

function normalize(value: string) {
  return repairTurkishPDFText(value)
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function personName(value: string) {
  const cleaned = value
    .replace(/[*†‡]+/g, "")
    .replace(/[0-9]/g, "")
    .trim();
  const words = cleaned.split(/\s+/);
  return (
    words.length >= 2 &&
    words.length <= 5 &&
    words.every((word) => /^[\p{L}.'’-]+$/u.test(word))
  );
}

function titleCase(value: string) {
  return value
    .toLocaleLowerCase("tr")
    .replace(
      /(^|[\s:/.–—-])(\p{L})/gu,
      (_all, prefix, letter) => `${prefix}${letter.toLocaleUpperCase("tr")}`,
    );
}

export function candidateFromPDFText(text: string): Candidate | null {
  const repaired = repairTurkishPDFText(text);
  const lines = repaired
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 180);
  const abstractIndex = lines.findIndex((line) =>
    /^(?:özet|abstract)\b/iu.test(line),
  );
  if (abstractIndex < 2) return null;

  let authorIndex = -1;
  for (let index = abstractIndex - 1; index >= 0; index--) {
    if (personName(lines[index])) {
      authorIndex = index;
      break;
    }
  }
  if (authorIndex < 1) return null;

  const possibleTitles = lines
    .slice(Math.max(0, authorIndex - 14), authorIndex)
    .filter(
      (line) =>
        !/^(?:t\.?\s*c\.?|issn|cilt|sayı|volume|number|doi|www\.|https?:)/iu.test(
          line,
        ),
    );
  const englishStart = possibleTitles.findIndex((line) =>
    /^(?:the|an?|analysis|solution|evaluation|study|effects?|relationship)\b/i.test(
      line,
    ),
  );
  const turkishTitles =
    englishStart > 0 ? possibleTitles.slice(0, englishStart) : possibleTitles;
  const title = titleCase(turkishTitles.join(" ").trim());
  if (title.length < 12 || title.length > 600) return null;

  const authorName = lines[authorIndex]
    .replace(/[*†‡]+/g, "")
    .replace(/İi$/u, "İ")
    .replace(/\s+i$/u, "")
    .trim();
  const authorParts = titleCase(authorName).split(/\s+/);
  const year = repaired.match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
  return {
    source: "PDF content",
    itemType: "journalArticle",
    title,
    authors: [
      {
        firstName: authorParts.slice(0, -1).join(" "),
        lastName: authorParts.at(-1) || authorName,
      },
    ],
    year,
    publisher: "",
  };
}

function titleCoverage(left: string, right: string) {
  const expected = normalize(left)
    .split(" ")
    .filter((token) => token.length > 1);
  const actual = new Set(normalize(right).split(" ").filter(Boolean));
  if (!expected.length) return 0;
  return expected.filter((token) => actual.has(token)).length / expected.length;
}

async function requestJSON(url: string) {
  const response = await (Zotero.HTTP as any).request("GET", url, {
    responseType: "json",
    timeout: 30000,
    successCodes: [200],
  });
  return (
    response.response ??
    (response.responseText ? JSON.parse(response.responseText) : null)
  );
}

function crossrefType(value: string) {
  if (/journal-article|proceedings-article/i.test(value)) {
    return value === "proceedings-article"
      ? "conferencePaper"
      : "journalArticle";
  }
  if (/book-chapter|book-section/i.test(value)) return "bookSection";
  if (/book|monograph|reference-book/i.test(value)) return "book";
  if (/dissertation/i.test(value)) return "thesis";
  if (/report/i.test(value)) return "report";
  return "document";
}

function candidateFromCrossref(message: any): Candidate | null {
  const title = String(message?.title?.[0] || "").trim();
  if (!title) return null;
  const dateParts =
    message?.issued?.["date-parts"]?.[0] ||
    message?.published?.["date-parts"]?.[0] ||
    [];
  return {
    source: "Crossref",
    itemType: crossrefType(String(message.type || "")),
    title,
    authors: Array.isArray(message.author)
      ? message.author.map((author: any) => ({
          firstName: String(author.given || ""),
          lastName: String(author.family || author.name || ""),
        }))
      : [],
    year: dateParts[0] ? String(dateParts[0]) : "",
    publisher: String(message.publisher || ""),
    publicationTitle: String(message["container-title"]?.[0] || ""),
    volume: String(message.volume || ""),
    issue: String(message.issue || ""),
    pages: String(message.page || ""),
    doi: String(message.DOI || ""),
    isbn: String(message.ISBN?.[0] || ""),
    url: String(message.URL || ""),
  };
}

async function crossrefByDOI(doi: string) {
  const body = await requestJSON(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
  );
  return candidateFromCrossref(body?.message);
}

async function crossrefByTitle(title: string, evidence: string) {
  if (!title || /^(?:pdf|untitled|document)$/i.test(title)) return null;
  const body = await requestJSON(
    `https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent(
      title,
    )}`,
  );
  const candidates = (body?.message?.items || [])
    .map(candidateFromCrossref)
    .filter(Boolean) as Candidate[];
  candidates.sort(
    (a, b) =>
      titleCoverage(b.title, `${title} ${evidence}`) -
      titleCoverage(a.title, `${title} ${evidence}`),
  );
  const best = candidates[0];
  return best && titleCoverage(best.title, `${title} ${evidence}`) >= 0.8
    ? best
    : null;
}

async function openLibraryByISBN(isbn: string): Promise<Candidate | null> {
  const edition = await requestJSON(
    `https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`,
  );
  if (!edition?.title) return null;
  const authors: Candidate["authors"] = [];
  for (const ref of (edition.authors || []).slice(0, 8)) {
    if (!ref?.key) continue;
    try {
      const author = await requestJSON(
        `https://openlibrary.org${ref.key}.json`,
      );
      const name = String(author?.name || "").trim();
      const parts = name.split(/\s+/);
      if (name) {
        authors.push({
          firstName: parts.slice(0, -1).join(" "),
          lastName: parts.at(-1) || name,
        });
      }
    } catch (error) {
      ztoolkit.log("Open Library author lookup failed", ref.key, error);
    }
  }
  return {
    source: "Open Library",
    itemType: "book",
    title: [edition.title, edition.subtitle].filter(Boolean).join(": "),
    authors,
    year: String(edition.publish_date || "").match(/\b\d{4}\b/)?.[0] || "",
    publisher: String(edition.publishers?.[0] || ""),
    isbn,
    url: edition.key
      ? `https://openlibrary.org${edition.key}`
      : `https://openlibrary.org/isbn/${isbn}`,
  };
}

async function evidenceFromPDF(attachment: Zotero.Item) {
  const path = await attachment.getFilePathAsync();
  if (!path || !(await IOUtils.exists(path))) {
    throw new Error("PDF file is missing");
  }
  let embeddedTitle = "";
  let embeddedAuthor = "";
  try {
    const raw = await IOUtils.read(path);
    const pdf = await PDFDocument.load(
      Uint8Array.from(raw as ArrayLike<number>),
      { updateMetadata: false, ignoreEncryption: false },
    );
    embeddedTitle = pdf.getTitle() || "";
    embeddedAuthor = pdf.getAuthor() || "";
  } catch (error) {
    ztoolkit.log("Could not read embedded PDF metadata", attachment.id, error);
  }
  let text = "";
  try {
    const result = await (Zotero as any).PDFWorker.getFullText(
      attachment.id,
      15,
    );
    text = String(result?.text || "");
  } catch (error) {
    ztoolkit.log("Could not extract PDF text for metadata research", error);
  }
  const evidence = repairTurkishPDFText(
    `${embeddedTitle}\n${embeddedAuthor}\n${text}`,
  ).slice(0, 250_000);
  return {
    evidence,
    embeddedTitle,
    identifiers: extractDocumentIdentifiers(evidence),
  };
}

function safeSet(item: Zotero.Item, field: string, value?: string) {
  if (!value) return;
  try {
    item.setField(field as any, value);
  } catch {
    // Candidate schemas contain fields unsupported by some Zotero item types.
  }
}

async function existingItem(candidate: Candidate, libraryID: number) {
  const items = await Zotero.Items.getAll(libraryID, true, false);
  return items.find((item) => {
    if (!item.isRegularItem()) return false;
    const doi = normalize(String(item.getField("DOI") || ""));
    const isbn = String(item.getField("ISBN") || "").replace(/[^\dX]/gi, "");
    return (
      Boolean(candidate.doi && doi === normalize(candidate.doi)) ||
      Boolean(candidate.isbn && isbn === candidate.isbn.replace(/[^\dX]/gi, ""))
    );
  });
}

async function createItem(candidate: Candidate, libraryID: number) {
  const item = new Zotero.Item(candidate.itemType as any);
  item.libraryID = libraryID;
  safeSet(item, "title", candidate.title);
  safeSet(item, "date", candidate.year);
  safeSet(item, "publisher", candidate.publisher);
  safeSet(item, "publicationTitle", candidate.publicationTitle);
  safeSet(item, "volume", candidate.volume);
  safeSet(item, "issue", candidate.issue);
  safeSet(item, "pages", candidate.pages);
  safeSet(item, "DOI", candidate.doi);
  safeSet(item, "ISBN", candidate.isbn);
  safeSet(item, "url", candidate.url);
  if (candidate.authors.length) {
    item.setCreators(
      candidate.authors.map((author) => ({
        ...author,
        creatorType: "author",
      })),
    );
  }
  item.addTag("#pdf-content-metadata");
  await item.saveTx();
  return item;
}

function preview(candidate: Candidate) {
  const authors = candidate.authors
    .map((author) => `${author.firstName} ${author.lastName}`.trim())
    .join("; ");
  return [
    `Kaynak: ${candidate.source}`,
    `Tür: ${candidate.itemType}`,
    `Başlık: ${candidate.title}`,
    `Yazar: ${authors || "—"}`,
    `Yıl: ${candidate.year || "—"}`,
    `Yayınevi/Dergi: ${
      candidate.publicationTitle || candidate.publisher || "—"
    }`,
    `DOI: ${candidate.doi || "—"}`,
    `ISBN: ${candidate.isbn || "—"}`,
    "",
    "Bu PDF doğru kayda taşınsın mı? Mevcut üst kayıt silinmeyecek.",
  ].join("\n");
}

export async function researchMetadataForSelectedPDFs() {
  const attachments = new Map<number, Zotero.Item>();
  for (const selected of ZoteroPane.getSelectedItems()) {
    if (
      selected.isAttachment() &&
      selected.attachmentContentType === "application/pdf"
    ) {
      attachments.set(selected.id, selected);
    }
  }
  let moved = 0;
  let found = 0;
  let skipped = 0;
  for (const attachment of attachments.values()) {
    try {
      const pdf = await evidenceFromPDF(attachment);
      let candidate: Candidate | null = null;
      if (pdf.identifiers.doi) {
        candidate = await crossrefByDOI(pdf.identifiers.doi);
      }
      if (!candidate && pdf.identifiers.isbn) {
        candidate = await openLibraryByISBN(pdf.identifiers.isbn);
      }
      const contentCandidate = candidateFromPDFText(pdf.evidence);
      if (!candidate && contentCandidate) {
        candidate = contentCandidate;
      }
      if (!candidate && pdf.embeddedTitle) {
        candidate = await crossrefByTitle(
          pdf.embeddedTitle,
          pdf.evidence.slice(0, 20_000),
        );
      }
      if (!candidate) {
        skipped++;
        continue;
      }
      found++;
      if (!window.confirm(preview(candidate))) continue;
      const target =
        (await existingItem(candidate, attachment.libraryID)) ||
        (await createItem(candidate, attachment.libraryID));
      if (target.id === attachment.parentItemID) continue;
      attachment.parentItemID = target.id;
      await attachment.saveTx();
      moved++;
    } catch (error) {
      skipped++;
      ztoolkit.log(
        "PDF content metadata research failed",
        attachment.id,
        error,
      );
    }
  }
  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 8000 })
    .createLine({
      text: `PDF content metadata: ${found} candidate(s), ${moved} PDF(s) moved, ${skipped} skipped`,
      type: moved ? "success" : "default",
    })
    .show();
  return { found, moved, skipped };
}
