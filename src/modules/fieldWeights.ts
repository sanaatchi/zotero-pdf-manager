// @ajan: cursor · @etiket: katman-2, field-weights, content-score
/**
 * OA / content-validate field weights — parity with
 * ``oa_pdf_search/field_weights.json`` + ``docs/oa-arama-alan-agirliklari.md``.
 *
 * Each kind's weights are fractions of 100 (sum ≈ 1.0). Content validation
 * only observes a subset (title / authors / year / publisher / publication /
 * isbn / doi); missing fields contribute 0.
 */

export type WeightKind =
  | "book"
  | "journalArticle"
  | "periodical"
  | "thesis"
  | "bookSection"
  | "document"
  | "magazineArticle"
  | "report"
  | "newspaperArticle";

/** Points/100 → 0..1 fractions (content-relevant fields only; others unused here). */
export const KIND_FIELD_WEIGHT: Record<
  WeightKind,
  Partial<Record<string, number>>
> = {
  book: {
    title: 0.3,
    authors: 0.25,
    year: 0.15,
    isbn: 0.1,
    publisher: 0.06,
    editors: 0.05,
    volume: 0.04,
    numPages: 0.02,
    translator: 0.01,
    place: 0.01,
    language: 0.01,
  },
  journalArticle: {
    title: 0.3,
    authors: 0.25,
    year: 0.15,
    doi: 0.1,
    publication: 0.06,
    editors: 0.04,
    volume: 0.04,
    issue: 0.03,
    pages: 0.01,
    translator: 0.01,
    language: 0.01,
  },
  periodical: {
    title: 0.35,
    year: 0.15,
    publisher: 0.15,
    publication: 0.12,
    volume: 0.08,
    issue: 0.06,
    place: 0.04,
    editors: 0.03,
    language: 0.02,
  },
  thesis: {
    title: 0.3,
    authors: 0.25,
    year: 0.15,
    university: 0.14,
    thesisType: 0.12,
    numPages: 0.02,
    place: 0.01,
    language: 0.01,
  },
  bookSection: {
    title: 0.3,
    authors: 0.25,
    year: 0.15,
    isbn: 0.1,
    bookTitle: 0.06,
    publisher: 0.06,
    editors: 0.04,
    pages: 0.01,
    translator: 0.01,
    place: 0.01,
    language: 0.01,
  },
  document: {
    title: 0.3,
    authors: 0.28,
    year: 0.2,
    publisher: 0.15,
    translator: 0.02,
    numPages: 0.02,
    place: 0.02,
    language: 0.01,
  },
  magazineArticle: {
    title: 0.3,
    authors: 0.25,
    year: 0.16,
    doi: 0.1,
    publisher: 0.06,
    publication: 0.06,
    volume: 0.02,
    issue: 0.02,
    pages: 0.01,
    place: 0.01,
    language: 0.01,
  },
  report: {
    title: 0.3,
    authors: 0.28,
    year: 0.18,
    publisher: 0.18,
    translator: 0.02,
    numPages: 0.02,
    place: 0.01,
    language: 0.01,
  },
  newspaperArticle: {
    title: 0.3,
    authors: 0.28,
    year: 0.2,
    publication: 0.18,
    pages: 0.02,
    place: 0.01,
    language: 0.01,
  },
};

const DEFAULT_KIND: WeightKind = "journalArticle";

/**
 * Decision thresholds on the 0..1 weighted scale (replaces additive
 * titleHit+0.5+0.3 scores that reached ~1.8).
 */
export const CONTENT_SCORE = {
  /** Primary match band (was additive ≥0.6). */
  HIGH: 0.5,
  /** Soft keep with titleHit≥0.5 (was additive ≥0.45). Demir≈0.42. */
  SOFT: 0.38,
  /** Strong title+score without author (was additive ≥0.55). */
  STRONG_PAIR: 0.42,
} as const;

export function weightedKindScore(
  kind: string,
  qualities: Record<string, number>,
): number {
  const table =
    KIND_FIELD_WEIGHT[(kind as WeightKind) || DEFAULT_KIND] ||
    KIND_FIELD_WEIGHT[DEFAULT_KIND];
  let total = 0;
  for (const [field, raw] of Object.entries(qualities || {})) {
    const q = Number(raw);
    if (!(q > 0)) continue;
    const w = table[field] || 0;
    if (w <= 0) continue;
    total += w * Math.min(1, q);
  }
  return Math.min(1, total);
}

/** Map Zotero itemType / content-validate book|other to weight kind. */
export function contentScoreKind(input: {
  itemType?: string;
  bookLike?: boolean;
}): WeightKind {
  const t = String(input.itemType || "")
    .trim()
    .toLowerCase();
  if (t && t in KIND_FIELD_WEIGHT) return t as WeightKind;
  if (input.bookLike) return "book";
  return DEFAULT_KIND;
}
