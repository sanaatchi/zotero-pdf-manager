// @ajan: cursor · @etiket: katman-2, oa-search, kinds-8, field-by-field
/**
 * OA Search kind → field schema (Zotero itemType-aligned).
 * UI shows/hides inputs; per-field active checkboxes; optional field-by-field
 * fan-out. Bridge receives structured criteria for ranking / discovery.
 */

export type OaSearchKind =
  | "book"
  | "journalArticle"
  | "bookSection"
  | "thesis"
  | "document"
  | "magazineArticle"
  | "report"
  | "newspaperArticle";

export type OaCriteriaFieldId =
  | "title"
  | "authors"
  | "doi"
  | "isbn"
  | "year"
  | "language"
  | "translator"
  | "publication"
  | "editors"
  | "bookTitle"
  | "publisher"
  | "thesisType"
  | "university"
  | "volume"
  | "issue"
  | "numPages"
  | "pages"
  | "place";

export type OaSearchCriteria = {
  kind: OaSearchKind;
  text: string;
  authors: string;
  doi: string;
  isbn: string;
  year: string;
  language: string;
  translator: string;
  publication: string;
  editors: string;
  bookTitle: string;
  publisher: string;
  thesisType: string;
  university: string;
  volume: string;
  issue: string;
  numPages: string;
  pages: string;
  place: string;
};

export const OA_SEARCH_KINDS: OaSearchKind[] = [
  "book",
  "journalArticle",
  "bookSection",
  "thesis",
  "document",
  "magazineArticle",
  "report",
  "newspaperArticle",
];

/**
 * Fields visible for each kind (order = form order after kind selector).
 * Aligns with docs/oa-arama-alan-agirliklari.md / field_weights.json for
 * fields that sources can actually filter on. Deliberately omits
 * volume / issue / numPages / pages / place — none of the OA APIs expose
 * those as search filters, so showing them would be misleading (fill → no
 * query change). Scoring still uses the full weight table server-side.
 */
export const KIND_FIELDS: Record<OaSearchKind, OaCriteriaFieldId[]> = {
  book: [
    "title",
    "authors",
    "year",
    "isbn",
    "publisher",
    "editors",
    "translator",
    "language",
  ],
  journalArticle: [
    "title",
    "authors",
    "year",
    "doi",
    "publication",
    "editors",
    "translator",
    "language",
  ],
  bookSection: [
    "title",
    "authors",
    "year",
    "isbn",
    "bookTitle",
    "publisher",
    "editors",
    "translator",
    "language",
  ],
  thesis: ["title", "authors", "year", "university", "thesisType", "language"],
  document: ["title", "authors", "year", "publisher", "translator", "language"],
  magazineArticle: [
    "title",
    "authors",
    "year",
    "doi",
    "publisher",
    "publication",
    "language",
  ],
  report: ["title", "authors", "year", "publisher", "translator", "language"],
  newspaperArticle: ["title", "authors", "year", "publication", "language"],
};

/**
 * Fields that can drive a standalone remote query in field-by-field mode.
 * Year/language alone are too broad — they stay soft filters on other queries.
 */
export const PRIMARY_SEARCH_FIELDS: ReadonlySet<OaCriteriaFieldId> = new Set([
  "title",
  "authors",
  "doi",
  "isbn",
  "publication",
  "editors",
  "bookTitle",
  "publisher",
  "translator",
  "thesisType",
  "university",
]);

export const FIELD_LABEL_KEY: Record<OaCriteriaFieldId, string> = {
  title: "oa-search-field-title",
  authors: "oa-search-field-authors",
  doi: "oa-search-field-doi",
  isbn: "oa-search-field-isbn",
  year: "oa-search-field-year",
  language: "oa-search-field-language",
  translator: "oa-search-field-translator",
  publication: "oa-search-field-publication",
  editors: "oa-search-field-editors",
  bookTitle: "oa-search-field-book-title",
  publisher: "oa-search-field-publisher",
  thesisType: "oa-search-field-thesis-type",
  university: "oa-search-field-university",
  volume: "oa-search-field-volume",
  issue: "oa-search-field-issue",
  numPages: "oa-search-field-num-pages",
  pages: "oa-search-field-pages",
  place: "oa-search-field-place",
};

export const FIELD_INPUT_ID: Record<OaCriteriaFieldId, string> = {
  title: "oa-q",
  authors: "oa-authors",
  doi: "oa-doi",
  isbn: "oa-isbn",
  year: "oa-year",
  language: "oa-language",
  translator: "oa-translator",
  publication: "oa-publication",
  editors: "oa-editors",
  bookTitle: "oa-book-title",
  publisher: "oa-publisher",
  thesisType: "oa-thesis-type",
  university: "oa-university",
  volume: "oa-volume",
  issue: "oa-issue",
  numPages: "oa-num-pages",
  pages: "oa-pages",
  place: "oa-place",
};

export function isOaSearchKind(value: string): value is OaSearchKind {
  return (OA_SEARCH_KINDS as string[]).includes(value);
}

export function isOaCriteriaFieldId(value: string): value is OaCriteriaFieldId {
  return value in FIELD_INPUT_ID;
}

/** Map Zotero itemType → OA Search kind. */
export function kindFromZoteroItemType(itemType: string): OaSearchKind {
  const t = String(itemType || "")
    .trim()
    .toLowerCase();
  if (t === "book" || t === "monograph") return "book";
  if (t === "booksection" || t === "bookSection") return "bookSection";
  if (t === "thesis") return "thesis";
  if (t === "magazinearticle") return "magazineArticle";
  if (t === "newspaperarticle") return "newspaperArticle";
  if (t === "report") return "report";
  if (t === "document" || t === "manuscript" || t === "presentation") {
    return "document";
  }
  if (
    t === "journalarticle" ||
    t === "journalArticle" ||
    t === "conferencepaper"
  ) {
    return "journalArticle";
  }
  return "journalArticle";
}

export function emptyCriteria(
  kind: OaSearchKind = "journalArticle",
): OaSearchCriteria {
  return {
    kind,
    text: "",
    authors: "",
    doi: "",
    isbn: "",
    year: "",
    language: "",
    translator: "",
    publication: "",
    editors: "",
    bookTitle: "",
    publisher: "",
    thesisType: "",
    university: "",
    volume: "",
    issue: "",
    numPages: "",
    pages: "",
    place: "",
  };
}

function fieldValue(c: OaSearchCriteria, id: OaCriteriaFieldId): string {
  switch (id) {
    case "title":
      return c.text.trim();
    case "authors":
      return c.authors.trim();
    case "doi":
      return c.doi.trim();
    case "isbn":
      return c.isbn.trim();
    case "year":
      return c.year.trim();
    case "language":
      return c.language.trim();
    case "translator":
      return c.translator.trim();
    case "publication":
      return c.publication.trim();
    case "editors":
      return c.editors.trim();
    case "bookTitle":
      return c.bookTitle.trim();
    case "publisher":
      return c.publisher.trim();
    case "thesisType":
      return c.thesisType.trim();
    case "university":
      return c.university.trim();
    case "volume":
      return c.volume.trim();
    case "issue":
      return c.issue.trim();
    case "numPages":
      return c.numPages.trim();
    case "pages":
      return c.pages.trim();
    case "place":
      return c.place.trim();
    default:
      return "";
  }
}

/** True when at least one active searchable criterion is filled. */
export function criteriaHasQuery(
  c: OaSearchCriteria,
  active?: ReadonlySet<OaCriteriaFieldId> | null,
): boolean {
  const fields = KIND_FIELDS[c.kind] || KIND_FIELDS.journalArticle;
  for (const id of fields) {
    if (active && !active.has(id)) continue;
    if (fieldValue(c, id)) return true;
  }
  return false;
}

/**
 * Zero out inactive fields so the bridge never soft-filters on them.
 * Soft filters (year/language) stay if still active.
 */
export function applyActiveFields(
  c: OaSearchCriteria,
  active: ReadonlySet<OaCriteriaFieldId>,
): OaSearchCriteria {
  const out = { ...c };
  const all: OaCriteriaFieldId[] = [
    "title",
    "authors",
    "doi",
    "isbn",
    "year",
    "language",
    "translator",
    "publication",
    "editors",
    "bookTitle",
    "publisher",
    "thesisType",
    "university",
    "volume",
    "issue",
    "numPages",
    "pages",
    "place",
  ];
  for (const id of all) {
    if (active.has(id)) continue;
    switch (id) {
      case "title":
        out.text = "";
        break;
      case "authors":
        out.authors = "";
        break;
      case "doi":
        out.doi = "";
        break;
      case "isbn":
        out.isbn = "";
        break;
      case "year":
        out.year = "";
        break;
      case "language":
        out.language = "";
        break;
      case "translator":
        out.translator = "";
        break;
      case "publication":
        out.publication = "";
        break;
      case "editors":
        out.editors = "";
        break;
      case "bookTitle":
        out.bookTitle = "";
        break;
      case "publisher":
        out.publisher = "";
        break;
      case "thesisType":
        out.thesisType = "";
        break;
      case "university":
        out.university = "";
        break;
      case "volume":
        out.volume = "";
        break;
      case "issue":
        out.issue = "";
        break;
      case "numPages":
        out.numPages = "";
        break;
      case "pages":
        out.pages = "";
        break;
      case "place":
        out.place = "";
        break;
    }
  }
  return out;
}

/**
 * Build focused queries for field-by-field fan-out.
 * Soft filters year/language are attached to every primary query when active.
 */
export function buildFieldByFieldQueries(
  c: OaSearchCriteria,
  active: ReadonlySet<OaCriteriaFieldId>,
): OaSearchCriteria[] {
  const base = applyActiveFields(c, active);
  const softYear = active.has("year") ? base.year : "";
  const softLang = active.has("language") ? base.language : "";
  const out: OaSearchCriteria[] = [];
  const fields = KIND_FIELDS[c.kind] || KIND_FIELDS.journalArticle;

  for (const id of fields) {
    if (!active.has(id) || !PRIMARY_SEARCH_FIELDS.has(id)) continue;
    const val = fieldValue(base, id);
    if (!val) continue;
    const q = emptyCriteria(c.kind);
    q.year = softYear;
    q.language = softLang;
    switch (id) {
      case "title":
        q.text = val;
        break;
      case "authors":
        q.authors = val;
        break;
      case "doi":
        q.doi = val;
        break;
      case "isbn":
        q.isbn = val;
        break;
      case "publication":
        q.publication = val;
        break;
      case "editors":
        q.editors = val;
        break;
      case "bookTitle":
        q.bookTitle = val;
        break;
      case "publisher":
        q.publisher = val;
        break;
      case "translator":
        q.translator = val;
        break;
      case "thesisType":
        q.thesisType = val;
        break;
      case "university":
        q.university = val;
        break;
      default:
        break;
    }
    if (criteriaHasQuery(q)) out.push(q);
  }
  return out;
}

export function parseActiveFieldsPref(raw: string): Set<OaCriteriaFieldId> {
  const known = new Set(Object.keys(FIELD_INPUT_ID) as OaCriteriaFieldId[]);
  const out = new Set<OaCriteriaFieldId>();
  const s = String(raw || "").trim();
  if (!s) {
    for (const id of known) out.add(id);
    return out;
  }
  for (const part of s.split(/[,;\s]+/)) {
    const id = part.trim();
    if (isOaCriteriaFieldId(id)) out.add(id);
  }
  return out.size ? out : new Set(known);
}

export function serializeActiveFieldsPref(
  active: ReadonlySet<OaCriteriaFieldId>,
): string {
  return [...active].sort().join(",");
}
