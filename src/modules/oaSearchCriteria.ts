// @ajan: cursor · @etiket: katman-2, oa-search, search-kind, criteria
/**
 * OA Search kind → field schema (Zotero itemType-aligned).
 * UI shows/hides inputs; bridge receives structured criteria for ranking.
 */

export type OaSearchKind = "book" | "journalArticle" | "bookSection" | "thesis";

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
  | "university";

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
};

export const OA_SEARCH_KINDS: OaSearchKind[] = [
  "book",
  "journalArticle",
  "bookSection",
  "thesis",
];

/** Fields visible for each kind (order = form order after kind selector). */
export const KIND_FIELDS: Record<OaSearchKind, OaCriteriaFieldId[]> = {
  book: ["title", "authors", "isbn", "year", "language", "translator"],
  journalArticle: [
    "title",
    "authors",
    "publication",
    "year",
    "doi",
    "language",
  ],
  bookSection: [
    "title",
    "authors",
    "editors",
    "bookTitle",
    "year",
    "publisher",
    "isbn",
    "language",
  ],
  thesis: ["title", "authors", "thesisType", "university", "year", "language"],
};

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
};

export function isOaSearchKind(value: string): value is OaSearchKind {
  return (OA_SEARCH_KINDS as string[]).includes(value);
}

/** Map Zotero itemType → OA Search kind. */
export function kindFromZoteroItemType(itemType: string): OaSearchKind {
  const t = String(itemType || "")
    .trim()
    .toLowerCase();
  if (t === "book" || t === "monograph") return "book";
  if (t === "booksection" || t === "bookSection") return "bookSection";
  if (t === "thesis") return "thesis";
  if (
    t === "journalarticle" ||
    t === "journalArticle" ||
    t === "magazinearticle" ||
    t === "newspaperarticle" ||
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
  };
}

/** True when at least one searchable criterion is filled. */
export function criteriaHasQuery(c: OaSearchCriteria): boolean {
  const fields = KIND_FIELDS[c.kind] || KIND_FIELDS.journalArticle;
  for (const id of fields) {
    if (id === "title" && c.text.trim()) return true;
    if (id === "authors" && c.authors.trim()) return true;
    if (id === "doi" && c.doi.trim()) return true;
    if (id === "isbn" && c.isbn.trim()) return true;
    if (id === "year" && c.year.trim()) return true;
    if (id === "language" && c.language.trim()) return true;
    if (id === "translator" && c.translator.trim()) return true;
    if (id === "publication" && c.publication.trim()) return true;
    if (id === "editors" && c.editors.trim()) return true;
    if (id === "bookTitle" && c.bookTitle.trim()) return true;
    if (id === "publisher" && c.publisher.trim()) return true;
    if (id === "thesisType" && c.thesisType.trim()) return true;
    if (id === "university" && c.university.trim()) return true;
  }
  return false;
}
