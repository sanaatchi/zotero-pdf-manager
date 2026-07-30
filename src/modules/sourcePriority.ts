// @ajan: cursor · @etiket: katman-2, source-priority, dergipark-only-tr
/**
 * Item-aware PDF source priority.
 *
 * Turkish journal articles → DergiPark only (no DOI/LibGen/Sci-Hub/…).
 * DergiPark itself only accepts journalArticle (scientific articles).
 *
 * Other policies:
 * - Foreign articles → article DBs; LibGen late fallback (book-heavy but OK).
 * - DOI (non-TR articles) → Sci-Hub early.
 * - Non-Turkish books → LibGen early.
 */
import { getDOI, isArticle, isBook, isThesis } from "./pdfSources";

/** Online article databases (used for non-Turkish articles). */
export const ARTICLE_DATABASE_IDS = [
  "dergipark",
  "doi",
  "arxiv",
  "pmc",
  "s2",
  "scihub",
] as const;

const TURKISH_CHARS = /[çğıöşüÇĞİÖŞÜ]/;
const TURKISH_LANG = /^(tr|tur|turkish|türkçe|turkce)\b/i;

export function itemHasDOI(item: Zotero.Item): boolean {
  try {
    return !!getDOI(item);
  } catch {
    return false;
  }
}

/** True when language/title looks Turkish (DergiPark-only path). */
export function looksTurkish(item: Zotero.Item): boolean {
  try {
    const lang = String(item.getField("language") || "").trim();
    if (lang && TURKISH_LANG.test(lang)) return true;
    if (lang && /^(en|eng|english|de|ger|german|fr|fra|french)\b/i.test(lang)) {
      return false;
    }
    const title = String(item.getField("title") || "");
    if (TURKISH_CHARS.test(title)) return true;
    return /\b(ve|ile|için|üzerine|hakkında|bir|olarak)\b/i.test(title);
  } catch {
    return false;
  }
}

/** Scientific journal article (DergiPark gate). */
export function isScientificJournalArticle(item: Zotero.Item): boolean {
  try {
    const name = (Zotero.ItemTypes as any).getName(item.itemTypeID) as string;
    return name === "journalArticle";
  } catch {
    return false;
  }
}

function moveAfter(
  ids: string[],
  target: string,
  afterId: string | null,
): string[] {
  if (!ids.includes(target)) return ids;
  const next = ids.filter((id) => id !== target);
  if (afterId === null) {
    next.unshift(target);
    return next;
  }
  const idx = next.indexOf(afterId);
  if (idx >= 0) next.splice(idx + 1, 0, target);
  else next.push(target);
  return next;
}

function moveToFrontAfterLocal(ids: string[], target: string): string[] {
  const localIdx = ids.indexOf("local");
  return moveAfter(ids, target, localIdx >= 0 ? "local" : null);
}

/**
 * Reorder / filter enabled cascade ids for one Zotero item.
 */
export function prioritizeSourcesForItem(
  baseIds: string[],
  item: Zotero.Item,
): string[] {
  let ids = [...baseIds];
  const turkish = looksTurkish(item);
  const hasDoi = itemHasDOI(item);
  const journal = isScientificJournalArticle(item);
  const article = isArticle(item);
  const book = isBook(item);

  // Türkçe bilimsel makale → yalnızca DergiPark (başka online kaynak yok).
  if (journal && turkish) {
    return ids.filter((id) => id === "dergipark");
  }

  if (article) {
    const allow = new Set<string>(["local", ...ARTICLE_DATABASE_IDS]);
    if (!turkish) allow.add("libgen");
    if (ids.includes("proquest")) allow.add("proquest");
    ids = ids.filter((id) => allow.has(id));

    if (hasDoi && ids.includes("scihub")) {
      ids = moveToFrontAfterLocal(ids, "scihub");
    }
    // Foreign article: LibGen late fallback only (after all article DBs).
    if (!turkish && ids.includes("libgen")) {
      ids = [...ids.filter((id) => id !== "libgen"), "libgen"];
    }
    return ids;
  }

  if (book) {
    if (!turkish && ids.includes("libgen")) {
      ids = moveToFrontAfterLocal(ids, "libgen");
    }
    return ids;
  }

  if (isThesis(item)) {
    return moveToFrontAfterLocal(ids, "yoktez");
  }

  if (hasDoi && ids.includes("scihub")) {
    ids = moveToFrontAfterLocal(ids, "scihub");
  }
  return ids;
}
