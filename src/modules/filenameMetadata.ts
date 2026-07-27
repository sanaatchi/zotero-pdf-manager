import { config } from "../../package.json";

declare const IOUtils: any;

export function yokThesisNumber(filename: string) {
  return filename.match(/^(\d{5,9})(?:\.pdf)?$/i)?.[1] || "";
}

function cleanCoverLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function coverSearch(value: string) {
  return cleanCoverLine(value).toLocaleLowerCase("tr-TR");
}

function looksLikePersonName(value: string) {
  const words = cleanCoverLine(value).split(/\s+/);
  return (
    words.length >= 2 &&
    words.length <= 5 &&
    words.every((word) => /^[\p{L}.'’-]+$/u.test(word)) &&
    !/(üniversit|enstit|fakülte|anabilim|bilim dal|tez|thesis|danışman)/u.test(
      coverSearch(value),
    )
  );
}

function cleanCoverAuthor(value: string) {
  return cleanCoverLine(value).replace(/^\d{6,12}\s+/, "");
}

export function parseThesisCoverText(text: string): FilenameMetadata {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(cleanCoverLine)
    .filter(Boolean)
    .slice(0, 160);
  const result: FilenameMetadata = { itemType: "thesis" };
  result.university = lines.find((line) =>
    /üniversitesi|university/u.test(coverSearch(line)),
  );
  const typeIndex = lines.findIndex((line) =>
    /yüksek lisans (?:tezi|eser metni)|doktora tezi|sanatta yeterlik tezi|master'?s thesis|doctoral thesis|ph\.?d\.? thesis/u.test(
      coverSearch(line),
    ),
  );
  if (typeIndex >= 0) {
    const marker = coverSearch(lines[typeIndex]);
    result.thesisType = /doktora|doctoral|ph\.?d/u.test(marker)
      ? "Doktora Tezi"
      : /sanatta yeterlik/u.test(marker)
        ? "Sanatta Yeterlik Tezi"
        : /eser metni/u.test(marker)
          ? "Yüksek Lisans Eser Metni"
        : "Yüksek Lisans Tezi";
  }

  const labelled = (labels: RegExp) => {
    const index = lines.findIndex((entry) => labels.test(coverSearch(entry)));
    if (index < 0) return "";
    const inline = lines[index].replace(/^[^:]+:\s*/, "").trim();
    return inline && inline !== lines[index] ? inline : lines[index + 1] || "";
  };
  const labelledAuthor = cleanCoverAuthor(
    labelled(/^(?:hazırlayan|yazar|author|prepared by)\s*:?/u),
  );
  if (labelledAuthor && looksLikePersonName(labelledAuthor)) {
    result.authors = [labelledAuthor];
  }
  const labelledTitle = labelled(/^(?:tez başlığı|başlık|title)\s*:?/u);
  if (labelledTitle.length >= 4) result.title = labelledTitle;

  // Many YÖK covers put the author immediately after the thesis-type line.
  if (typeIndex >= 0 && !result.authors) {
    const author = lines
      .slice(typeIndex + 1, typeIndex + 6)
      .map(cleanCoverAuthor)
      .find(
        (line) =>
          looksLikePersonName(line) &&
          !/(danışman|advisor|gaziantep|ankara|istanbul|izmir)/u.test(
            coverSearch(line),
          ),
      );
    if (author) result.authors = [author];
  }

  const noise =
    /(?:^[ivxlcdm]+$|^t\.?\s*c\.?$|üniversit|university|enstit|institute|fakülte|faculty|anabilim|ana\s*sanat|department|bilim dal|program)/u;
  if (typeIndex > 0 && !result.title) {
    const candidates = lines
      .slice(Math.max(0, typeIndex - 10), typeIndex)
      .filter((line) => !noise.test(coverSearch(line)));
    const possibleAuthor = candidates.at(-1);
    if (!result.authors && possibleAuthor && looksLikePersonName(possibleAuthor)) {
      result.authors = [possibleAuthor];
      candidates.pop();
    }
    const title = candidates.join(" ").trim();
    if (title.length >= 8 && title.length <= 500) result.title = title;
  }

  const years = lines.join(" ").match(/\b(?:19|20)\d{2}\b/g);
  if (years?.length) result.year = years.at(-1);
  return result;
}

export async function thesisCoverMetadataFromAttachment(
  attachment: Zotero.Item,
) {
  const fulltext = Zotero.Fulltext as any;
  try {
    await fulltext.indexItems([attachment.id], {
      complete: false,
      ignoreErrors: true,
    });
    const cachePath = fulltext.getItemCacheFile(attachment)?.path;
    if (!cachePath || !(await IOUtils.exists(cachePath))) {
      return { itemType: "thesis" } as FilenameMetadata;
    }
    const text = String(await Zotero.File.getContentsAsync(cachePath)).slice(
      0,
      20_000,
    );
    return parseThesisCoverText(text);
  } catch (error) {
    ztoolkit.log("Could not read thesis cover text", attachment.id, error);
    return { itemType: "thesis" } as FilenameMetadata;
  }
}

export interface FilenameMetadata {
  title?: string;
  shortTitle?: string;
  authors?: string[];
  year?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  edition?: string;
  pages?: string;
  place?: string;
  publicationTitle?: string;
  thesisType?: string;
  university?: string;
  itemType?: string;
  doi?: string;
  isbn?: string;
}

const ORIGINAL_TITLE_PREFIX = "ZPDF-Original-Title:";
const ORIGINAL_FILENAME_PREFIX = "ZPDF-Original-Filename:";

function clean(value: string) {
  return value
    .replace(/^[\s[\](){}]+|[\s[\](){}]+$/g, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function volumeAsRoman(value: string) {
  let number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 1 || number > 3999) return "";
  const numerals: Array<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let result = "";
  for (const [amount, numeral] of numerals) {
    while (number >= amount) {
      result += numeral;
      number -= amount;
    }
  }
  return result;
}

function titleWithRomanVolume(title: string, volume?: string) {
  const cleaned = clean(title);
  const roman = volume ? volumeAsRoman(volume) : "";
  if (!roman || new RegExp(`(?:^|\\s)${roman}$`, "i").test(cleaned)) {
    return cleaned;
  }
  return `${cleaned} ${roman}`;
}

function comparableRawTitle(value: string) {
  return value
    .replace(/\.(?:pdf|epub|djvu)$/i, "")
    .replace(/^\s*\(\)\s*/, "")
    .replace(/\s*\[(?:document|belge)\]\s*$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s*[-–—]\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("tr");
}

export function isRawFilenameTitle(currentTitle: string, filename: string) {
  return comparableRawTitle(currentTitle) === comparableRawTitle(filename);
}

export function sourceFilenameForMetadata(
  extra: string,
  attachmentPath: string,
) {
  const sourcePath = String(extra || "").match(
    /^ZPDF-Source-Path:\s*(.+?)\s*$/m,
  )?.[1];
  return String(sourcePath || attachmentPath).replace(/^.*[\\/]/, "");
}

export function preserveOriginalMetadataInExtra(
  extra: string,
  originalTitle: string,
  originalFilename: string,
) {
  const lines = String(extra || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const addOnce = (prefix: string, value: string) => {
    const cleaned = String(value || "").trim();
    if (!cleaned || lines.some((line) => line.startsWith(prefix))) return;
    lines.push(`${prefix} ${cleaned}`);
  };
  addOnce(ORIGINAL_TITLE_PREFIX, originalTitle);
  addOnce(ORIGINAL_FILENAME_PREFIX, originalFilename);
  return lines.join("\n");
}

function splitTitleAndVolume(value: string) {
  const match = clean(value).match(/\s+(\d{1,3})$/);
  if (!match) {
    return { title: clean(value) };
  }
  return {
    title: titleWithRomanVolume(clean(value.slice(0, match.index)), match[1]),
    volume: match[1],
  };
}

function titleWithOptionalSubtitle(value: string) {
  const title = clean(value);
  const parts = title.split(/\s+(?:—|–)\s+/);
  return {
    title,
    shortTitle: parts.length === 2 ? clean(parts[0]) : undefined,
  };
}

function normalizeFilenameYear(value: string) {
  if (/^(?:18|19|20)\d{2}$/.test(value)) return value;
  if (/^\d{4}$/.test(value)) {
    const swapped = value[1] + value[0] + value.slice(2);
    if (/^(?:18|19|20)\d{2}$/.test(swapped)) return swapped;
  }
  return "";
}

function isValidISBN(value: string) {
  if (/^\d{13}$/.test(value)) {
    const sum = value
      .slice(0, 12)
      .split("")
      .reduce(
        (total, digit, index) =>
          total + Number(digit) * (index % 2 ? 3 : 1),
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
}

function labelledValue(stem: string, labels: string[]) {
  const names = labels.join("|");
  const match = stem.match(
    new RegExp(
      `(?:^|__|\\[)\\s*(?:${names})\\s*[:=]\\s*(.+?)(?=__|\\]|$)`,
      "iu",
    ),
  );
  return match ? clean(match[1]) : "";
}

const ITEM_TYPE_ALIASES: Record<string, string> = {
  book: "book",
  kitap: "book",
  journalarticle: "journalArticle",
  article: "journalArticle",
  makale: "journalArticle",
  thesis: "thesis",
  tez: "thesis",
  dissertation: "thesis",
  mastersthesis: "thesis",
  yükseklisanstezi: "thesis",
  doktoratezi: "thesis",
  phdthesis: "thesis",
  doctoralthesis: "thesis",
  report: "report",
  rapor: "report",
  conferencepaper: "conferencePaper",
  bildiri: "conferencePaper",
  booksection: "bookSection",
  kitapbölümü: "bookSection",
  webpage: "webpage",
  websayfası: "webpage",
  videorecording: "videoRecording",
  video: "videoRecording",
  manuscript: "manuscript",
  elyazması: "manuscript",
  presentation: "presentation",
  sunum: "presentation",
  newspaperarticle: "newspaperArticle",
  gazetemakalesi: "newspaperArticle",
  magazinearticle: "magazineArticle",
  dergimakalesi: "magazineArticle",
  encyclopediaarticle: "encyclopediaArticle",
  ansiklopedimaddesi: "encyclopediaArticle",
  dictionaryentry: "dictionaryEntry",
  sözlükgirdisi: "dictionaryEntry",
  preprint: "preprint",
  önbaskı: "preprint",
  document: "document",
  belge: "document",
};

function normalizeItemType(value: string) {
  const key = clean(value)
    .toLocaleLowerCase("tr")
    .replace(/[\s_-]+/g, "");
  return ITEM_TYPE_ALIASES[key] || "";
}

function splitExplicitAuthors(value: string) {
  return clean(value)
    .split(
      /\s+(?:ve|and|&)\s+|,\s*(?=[^\s,]+\s+(?:[\p{Lu}]\.?\s*){1,4}(?:,|$))/giu,
    )
    .map(clean)
    .filter(Boolean);
}

export function parseFilenameMetadata(filename: string): FilenameMetadata {
  const stem = filename
    .replace(/\.[^.]+$/, "")
    .replace(/^\s*\(\)\s*/, "")
    .replace(/\s*\[(?:document|belge)\]\s*$/i, "")
    // LibGen collection/series prefixes are not part of the author or title.
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
  // A filename without an explicit, recognized publication marker remains a
  // generic Zotero document. We never infer article/book/thesis from wording.
  const metadata: FilenameMetadata = { itemType: "document" };

  const doi = stem.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i)?.[0];
  if (doi) metadata.doi = doi.replace(/[).,;]+$/, "");
  // Some LibGen filenames replace the DOI slash with a space and wrap the
  // DOI in brackets: [10.4324 9781315727240].
  const spacedDOI = stem.match(
    /\[\s*(10\.\d{4,9})\s+([A-Z0-9][A-Z0-9._;():/-]*)\s*\]/i,
  );
  if (!metadata.doi && spacedDOI) {
    metadata.doi = `${spacedDOI[1]}/${spacedDOI[2]}`;
  }
  const isbnRaw = stem.match(
    /(?:ISBN(?:-1[03])?\s*[:=_-]?\s*)((?:97[89][\s-]?)?\d[\d\s-]{8,16}[\dX])/i,
  )?.[1];
  if (isbnRaw) {
    const isbn = isbnRaw.replace(/[\s-]/g, "");
    if (isValidISBN(isbn)) metadata.isbn = isbn;
  }
  if (!metadata.isbn && spacedDOI && isValidISBN(spacedDOI[2])) {
    metadata.isbn = spacedDOI[2];
  }

  const labelled: Record<string, string> = {};
  const labelPattern =
    /(?:^|[\[({]|\s{2,}|__)(yazar|author|başlık|baslik|title|yıl|yil|year|yayınevi|yayinevi|publisher)\s*[:=]\s*([^\])}]+?)(?=(?:[\]})]|__|\s{2,}(?:yazar|author|başlık|baslik|title|yıl|yil|year|yayınevi|yayinevi|publisher)\s*[:=]|$))/giu;
  for (const match of stem.matchAll(labelPattern)) {
    labelled[match[1].toLocaleLowerCase("tr")] = clean(match[2]);
  }
  const labelledTitle =
    labelled["başlık"] || labelled.baslik || labelled.title;
  if (labelledTitle) metadata.title = labelledTitle;
  const labelledAuthor = labelled.yazar || labelled.author;
  if (labelledAuthor) {
    metadata.authors = labelledAuthor
      .split(/\s*(?:;|&|\band\b|\bve\b)\s*/i)
      .map(clean)
      .filter(Boolean);
  }
  const labelledYear =
    labelled["yıl"] ||
    labelled.yil ||
    labelled.year?.match(/\b(?:18|19|20)\d{2}\b/)?.[0];
  if (labelledYear) metadata.year = labelledYear;
  const labelledPublisher =
    labelled["yayınevi"] ||
    labelled.yayinevi ||
    labelled.publisher;
  if (labelledPublisher) metadata.publisher = labelledPublisher;
  const explicitFields: Array<
    [keyof FilenameMetadata, string[]]
  > = [
    ["volume", ["cilt", "volume", "vol"]],
    ["issue", ["sayı", "sayi", "issue", "no"]],
    ["edition", ["baskı", "baski", "edition", "ed"]],
    ["pages", ["sayfa", "pages", "pp"]],
    ["place", ["yer", "şehir", "sehir", "place", "city"]],
    [
      "publicationTitle",
      ["dergi", "journal", "publication", "publicationTitle"],
    ],
  ];
  for (const [field, labels] of explicitFields) {
    const value = labelledValue(stem, labels);
    if (value) (metadata as Record<string, unknown>)[field] = value;
  }
  if (metadata.title || metadata.authors) {
    if (metadata.title && metadata.volume) {
      metadata.title = titleWithRomanVolume(metadata.title, metadata.volume);
    }
    return metadata;
  }

  const archiveParts = stem
    .split(/\s+(?:-|–|—)\s+/)
    .map(clean)
    .filter(Boolean);
  // Curated archive form:
  // Author - Title - Year - Publisher - ISBN 978.../NA - catalogue code
  if (
    archiveParts.length >= 6 &&
    /^(?:0000|(?:18|19|20)\d{2})$/.test(archiveParts[2]) &&
    /^ISBN\s+(?:NA|(?:97[89])?\d[\d-]{8,16})$/i.test(archiveParts[4]) &&
    /^[A-Z]{1,5}\d{3,}$/i.test(archiveParts[5])
  ) {
    metadata.authors = [archiveParts[0]];
    metadata.title = archiveParts[1];
    if (archiveParts[2] !== "0000") metadata.year = archiveParts[2];
    if (!/^unknown$/i.test(archiveParts[3])) {
      metadata.publisher = archiveParts[3];
    }
    metadata.itemType = "book";
    return metadata;
  }

  const withoutIdentifiers = stem
    .replace(
      /\[\s*10\.\d{4,9}\s+[A-Z0-9][A-Z0-9._;():/-]*\s*\]/gi,
      "",
    )
    .replace(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi, "")
    .replace(/ISBN(?:-1[03])?\s*[:=_-]?\s*[\dX\s-]+/gi, "");
  const typed = withoutIdentifiers.match(
    /^(.{2,100}?)\s*\((\d{4})\)\s*(.{3,}?)\.?\s*\[([^\]]+)\]\s*(.*)$/,
  );
  if (typed) {
    const itemType = normalizeItemType(typed[4]);
    if (itemType) {
      const trailing = clean(typed[5]);
      metadata.authors = splitExplicitAuthors(typed[1]);
      metadata.year = normalizeFilenameYear(typed[2]) || undefined;
      metadata.title = clean(typed[3]).replace(/[.\s]+$/, "");
      metadata.itemType = itemType;
      const normalizedMarker = clean(typed[4]).toLocaleLowerCase("tr");
      if (
        itemType === "thesis" &&
        /yüksek\s+lisans|master/.test(normalizedMarker)
      ) {
        metadata.thesisType = "Yüksek Lisans Tezi";
      } else if (
        itemType === "thesis" &&
        /doktora|phd|doctoral/.test(normalizedMarker)
      ) {
        metadata.thesisType = "Doktora Tezi";
      }
      if (trailing) {
        if (itemType === "journalArticle") {
          metadata.publicationTitle = trailing;
        } else if (itemType === "book") {
          metadata.publisher = trailing;
        } else if (itemType === "thesis") {
          metadata.publisher = trailing;
        }
      }
      return metadata;
    }
  }

  const apa = withoutIdentifiers.match(
    /^([^,]{1,80},\s*[^.]{1,80})\.\s*\(((?:18|19|20)\d{2})\)\.\s*(.{3,}?)\.\s*([^.]{2,})\.?$/,
  );
  if (apa) {
    metadata.authors = [clean(apa[1])];
    metadata.year = apa[2];
    metadata.title = clean(apa[3]);
    metadata.publisher = clean(apa[4]);
    return metadata;
  }

  const apaArchive = stem.match(
    /^([^,]{1,80},\s*[^()]{1,80})\s*\(((?:18|19|20)\d{2})\)\.\s*(.{3,}?)\.\s*(.{2,}?)\s+-\s+ISBN\s+(NA|(?:97[89])?\d[\d-]{8,16})\s+-\s+[A-Z]{1,5}\d{3,}$/i,
  );
  if (apaArchive) {
    metadata.authors = [clean(apaArchive[1])];
    metadata.year = apaArchive[2];
    metadata.title = clean(apaArchive[3]);
    if (!/^unknown$/i.test(clean(apaArchive[4]))) {
      metadata.publisher = clean(apaArchive[4]);
    }
    const archiveISBN = apaArchive[5].replace(/-/g, "");
    if (/^(?:\d{13}|\d{9}[\dX])$/i.test(archiveISBN)) {
      metadata.isbn = archiveISBN;
    }
    metadata.itemType = "book";
    return metadata;
  }

  const explicitThesis = withoutIdentifiers.match(
    /^(.{2,100}?)\.\s+(.{3,}?)\.\s+([^,]{3,}?),\s*\[(yüksek lisans tezi|doktora tezi|sanatta yeterlik(?: tezi)?|master'?s thesis|doctoral thesis|phd thesis)\],?\s*((?:18|19|20)\d{2})$/i,
  );
  if (explicitThesis) {
    metadata.authors = [clean(explicitThesis[1])];
    metadata.title = clean(explicitThesis[2]);
    metadata.university = clean(explicitThesis[3]);
    metadata.year = explicitThesis[5];
    metadata.itemType = "thesis";
    const marker = explicitThesis[4].toLocaleLowerCase("tr");
    metadata.thesisType = /doktora|doctoral|phd/.test(marker)
      ? "Doktora Tezi"
      : /yüksek lisans|master/.test(marker)
        ? "Yüksek Lisans Tezi"
        : "Sanatta Yeterlik Tezi";
    return metadata;
  }

  const braceArchive = withoutIdentifiers.match(
    /^(.{3,}?)\{([^{}]+)\}\(((?:18|19|20)\d{2})(?:[^,]*)?,\s*([^)]+)\)(?:\[[^\]]+\])?\{\d+\}\s*(?:libgen(?:\.li)?)?$/i,
  );
  if (braceArchive) {
    const title = titleWithOptionalSubtitle(braceArchive[1]);
    metadata.title = title.title;
    metadata.shortTitle = title.shortTitle;
    const authorText = clean(braceArchive[2]);
    if (!/\b(?:editor|editör|ed\.)\b/i.test(authorText)) {
      metadata.authors = authorText
        .split(/\s*;\s*/)
        .map(clean)
        .filter(Boolean);
    }
    metadata.year = braceArchive[3];
    metadata.publisher = clean(braceArchive[4]);
    metadata.itemType = "book";
    return metadata;
  }

  const braceArchiveWithoutYear = withoutIdentifiers.match(
    /^(.{3,}?)\{([^{}]+)\}\(([^(),]{2,100})\)\{\d+\}\s*(?:libgen(?:\.li)?)?$/i,
  );
  if (braceArchiveWithoutYear) {
    if (/^(?:18|19|20)\d{2}$/.test(clean(braceArchiveWithoutYear[3]))) {
      const title = titleWithOptionalSubtitle(braceArchiveWithoutYear[1]);
      metadata.title = title.title;
      metadata.shortTitle = title.shortTitle;
      metadata.authors = [clean(braceArchiveWithoutYear[2])];
      metadata.year = clean(braceArchiveWithoutYear[3]);
      metadata.itemType = "book";
      return metadata;
    }
    const title = splitTitleAndVolume(braceArchiveWithoutYear[1]);
    metadata.title = title.title;
    if (title.volume) metadata.volume = title.volume;
    const authorText = clean(braceArchiveWithoutYear[2]);
    if (!/\b(?:editor|editör|ed\.)\b/i.test(authorText)) {
      metadata.authors = authorText
        .split(/\s*;\s*/)
        .map(clean)
        .filter(Boolean);
    }
    metadata.publisher = clean(braceArchiveWithoutYear[3]);
    metadata.itemType = "book";
    return metadata;
  }

  const bibliographic = withoutIdentifiers.match(
    /^(.{2,100}?)\s+(?:—|–|-)\s+(.{3,}?)\s*\(((?:18|19|20)\d{2})\s*,\s*([^)]+)\)(?:\s+(?:—|–|-)\s+.+)?$/,
  );
  if (bibliographic) {
    const title = splitTitleAndVolume(bibliographic[2]);
    metadata.authors = [clean(bibliographic[1])];
    metadata.title = title.title;
    if (title.volume) metadata.volume = title.volume;
    metadata.year = bibliographic[3];
    metadata.publisher = clean(bibliographic[4]);
    metadata.itemType = "book";
    return metadata;
  }

  const bibliographicWithoutYear = withoutIdentifiers.match(
    /^(.{2,100}?)\s+(?:—|–|-)\s+(.{3,}?)\s*\(([^(),]{2,100})\)(?:\s+(?:—|–|-)\s+(?:libgen(?:\.li)?|.+))?$/i,
  );
  if (bibliographicWithoutYear) {
    metadata.authors = [clean(bibliographicWithoutYear[1])];
    metadata.title = clean(bibliographicWithoutYear[2]);
    metadata.publisher = clean(bibliographicWithoutYear[3]);
    metadata.itemType = "book";
    return metadata;
  }

  const parenthesized = withoutIdentifiers.match(
    /^(.{2,80}?)\s*\(((?:18|19|20)\d{2})\)\s*(.{3,})$/,
  );
  if (parenthesized) {
    metadata.authors = [clean(parenthesized[1])];
    metadata.year = parenthesized[2];
    metadata.title = clean(parenthesized[3]);
    return metadata;
  }

  const rawParts = withoutIdentifiers
    .split(/\s+(?:-|–|—)\s+/)
    .filter(Boolean);
  const parts = rawParts
    .map(clean)
    .filter(Boolean);
  const yearIndex = parts.findIndex((part) =>
    /^(?:18|19|20)\d{2}$/.test(part),
  );
  const bracketYearIndex = rawParts.findIndex((part) =>
    /^\[(?:18|19|20)\d{2}\]$/.test(part),
  );
  const knownPlace =
    /^(?:Bakü|Bakı|Baku|Tebriz|Ankara|İstanbul|Istanbul|İzmir|Izmir|Bursa|Konya|London|Londra|Paris|Berlin|New York)$/iu;
  if (
    parts.length === 4 &&
    yearIndex === 3 &&
    knownPlace.test(parts[2]) &&
    parts[1].split(/\s+/).length >= 2 &&
    parts[1].split(/\s+/).length <= 6
  ) {
    metadata.title = parts[0];
    metadata.authors = [parts[1]];
    metadata.place = parts[2];
    metadata.year = parts[3];
    metadata.itemType = "book";
    return metadata;
  }
  if (parts.length === 4 && bracketYearIndex === 2) {
    metadata.authors = [parts[0]];
    metadata.title = parts[1];
    metadata.year = clean(rawParts[2]);
    metadata.publisher = parts[3];
    return metadata;
  }
  if (parts.length === 4 && yearIndex === 3) {
    metadata.authors = [parts[0]];
    metadata.title = parts[1];
    metadata.publisher = parts[2];
    metadata.year = parts[3];
    return metadata;
  }
  if (parts.length === 4 && yearIndex === 1) {
    metadata.authors = [parts[0]];
    metadata.year = parts[1];
    metadata.title = parts[2];
    metadata.publisher = parts[3];
    return metadata;
  }
  // Conservative common forms: "Author - 2020 - Title" and
  // "Author - Title - 2020". Positional publisher guessing is deliberately
  // avoided; publisher is accepted only when explicitly labelled.
  if (parts.length >= 3 && (yearIndex === 1 || yearIndex === parts.length - 1)) {
    metadata.authors = [parts[0]];
    metadata.year = parts[yearIndex];
    const titleParts = parts.filter(
      (_part, index) => index !== 0 && index !== yearIndex,
    );
    metadata.title = clean(titleParts.join(" — "));
  }
  return metadata;
}

function creatorFromName(name: string) {
  const comma = name.match(/^([^,]+),\s*(.+)$/);
  if (comma) {
    return {
      firstName: comma[2].trim(),
      lastName: comma[1].trim(),
      creatorType: "author",
    };
  }
  const surnameInitials = clean(name).match(
    /^(\S+)\s+((?:[\p{Lu}]\.?\s*){1,4})$/u,
  );
  if (surnameInitials) {
    return {
      firstName: surnameInitials[2].trim(),
      lastName: surnameInitials[1].trim(),
      creatorType: "author",
    };
  }
  const parts = clean(name).split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      firstName: parts.slice(0, -1).join(" "),
      lastName: parts.at(-1)!,
      creatorType: "author",
    };
  }
  return {
    firstName: "",
    lastName: parts[0] || clean(name),
    creatorType: "author",
  };
}

export function applyFilenameMetadata(
  item: Zotero.Item,
  metadata: FilenameMetadata,
  allowExplicitTypeCorrection = false,
) {
  const changed: string[] = [];
  if (metadata.itemType) {
    try {
      const currentType = (Zotero.ItemTypes as any).getName(
        (item as any).itemTypeID,
      );
      const targetTypeID = (Zotero.ItemTypes as any).getID(metadata.itemType);
      // Changing a populated specialized type can discard unsupported fields.
      // A generic document is safe to specialize when the filename says so
      // explicitly; other existing types are preserved.
      if (
        (currentType === "document" ||
          (allowExplicitTypeCorrection &&
            metadata.itemType !== "document")) &&
        currentType !== metadata.itemType &&
        targetTypeID &&
        typeof (item as any).setType === "function"
      ) {
        (item as any).setType(targetTypeID);
        changed.push("itemType");
      }
    } catch {
      // Unsupported/unknown Zotero type: keep the existing item type.
    }
  }
  const setMissing = (field: string, value?: string) => {
    if (!value) return;
    try {
      if (!String((item as any).getField(field) || "").trim()) {
        (item as any).setField(field, value);
        changed.push(field);
      }
    } catch {
      // The selected Zotero item type may not support every parsed field.
    }
  };

  setMissing("title", metadata.title);
  setMissing("shortTitle", metadata.shortTitle);
  setMissing("date", metadata.year);
  setMissing("publisher", metadata.publisher);
  setMissing("volume", metadata.volume);
  setMissing("issue", metadata.issue);
  setMissing("edition", metadata.edition);
  setMissing("pages", metadata.pages);
  setMissing("place", metadata.place);
  setMissing("publicationTitle", metadata.publicationTitle);
  setMissing("thesisType", metadata.thesisType);
  setMissing("university", metadata.university);
  setMissing("DOI", metadata.doi);
  setMissing("ISBN", metadata.isbn);
  if (
    metadata.authors?.length &&
    (((item as any).getCreators?.() || []) as unknown[]).length === 0
  ) {
    (item as any).setCreators(metadata.authors.map(creatorFromName));
    changed.push("creators");
  }
  return changed;
}

export async function fillMetadataFromSelectedPDFFilenames() {
  const attachments = new Map<number, Zotero.Item>();
  for (const selected of ZoteroPane.getSelectedItems()) {
    if (
      selected.isAttachment() &&
      selected.attachmentContentType === "application/pdf"
    ) {
      attachments.set(selected.id, selected);
    } else if (selected.isRegularItem()) {
      for (const id of selected.getAttachments()) {
        const attachment = Zotero.Items.get(id);
        if (attachment?.attachmentContentType === "application/pdf") {
          attachments.set(id, attachment);
        }
      }
    }
  }

  let updated = 0;
  let skipped = 0;
  for (const attachment of attachments.values()) {
    const parent =
      attachment.parentItem ||
      (attachment.parentItemID
        ? Zotero.Items.get(attachment.parentItemID)
        : null);
    const path = await attachment.getFilePathAsync();
    if (!parent?.isRegularItem() || !path) {
      skipped++;
      continue;
    }
    const filename = sourceFilenameForMetadata(
      String((parent as any).getField("extra") || ""),
      path,
    );
    let parsed = parseFilenameMetadata(filename);
    const thesisNumber = yokThesisNumber(filename);
    if (thesisNumber) {
      parsed = {
        ...parsed,
        ...(await thesisCoverMetadataFromAttachment(attachment)),
        itemType: "thesis",
      };
      const currentExtra = String((parent as any).getField("extra") || "");
      if (!/^YÖK Tez No:/m.test(currentExtra)) {
        (parent as any).setField(
          "extra",
          `${currentExtra}\nYÖK Tez No: ${thesisNumber}`.trim(),
        );
      }
    }
    const tags = (((parent as any).getTags?.() || []) as any[]).map((tag) =>
      typeof tag === "string" ? tag : tag?.tag,
    );
    const currentTitle = String((parent as any).getField("title") || "");
    let preservedExtraChanged = false;
    // The initial orphan importer used the entire filename as a fallback
    // title. For auto-created records only, allow the manual repair command
    // to replace that known placeholder while preserving user-written titles.
    if (parsed.title && tags.includes("#auto-created")) {
      const currentExtra = String((parent as any).getField("extra") || "");
      const extra = preserveOriginalMetadataInExtra(
        currentExtra,
        currentTitle,
        filename,
      );
      if (extra !== currentExtra) {
        (parent as any).setField("extra", extra);
        preservedExtraChanged = true;
      }
      if (currentTitle !== parsed.title) {
        // Auto-created records are explicitly repairable from their preserved
        // source filename. The previous title remains recoverable in Extra.
        (parent as any).setField("title", "");
      }
    }
    const changed = applyFilenameMetadata(
      parent,
      parsed,
      tags.includes("#auto-created"),
    );
    if (preservedExtraChanged) changed.push("extra");
    if (!changed.length) {
      skipped++;
      continue;
    }
    parent.addTag("#filename-metadata");
    if (thesisNumber) parent.addTag("#pdf-cover-metadata");
    await parent.saveTx();
    updated++;
  }

  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
    .createLine({
      text: `Filename metadata: ${updated} updated, ${skipped} skipped`,
      type: updated ? "success" : "default",
    })
    .show();
  return { updated, skipped };
}
