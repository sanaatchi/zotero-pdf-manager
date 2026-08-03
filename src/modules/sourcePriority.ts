// @ajan: cursor · @etiket: katman-2, source-priority, article-db-core-zenodo
/**
 * Item-aware PDF source priority.
 *
 * Turkish journal articles → DergiPark first, then DOI/Unpaywall if the item
 *   has a DOI (exact-match, no fuzzy title search risk); no LibGen/Sci-Hub/PMC.
 * Theses → YÖKTez only (no local/proxy/LibGen/…).
 * DergiPark itself only accepts journalArticle (scientific articles).
 *
 * Other policies:
 * - Foreign articles → article DBs (doi/Unpaywall, pmc, …); LibGen late fallback.
 * - DOI (non-TR articles) → Unpaywall (`doi`) early; Sci-Hub only if in cascade.
 * - Non-Turkish books → LibGen early.
 */
import { getDOI, isArticle, isBook, isThesis } from "./pdfSources";

/** Online article download sources (used for non-Turkish articles). */
export const ARTICLE_DATABASE_IDS = [
  "doi",
  "dergipark",
  "pmc",
  "scihub",
  "core",
  "zenodo",
  "openaire",
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

/** True when language/title looks Turkish (DergiPark + optional Unpaywall path). */
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

  // Türkçe bilimsel makale → önce DergiPark, sonra (varsa) DOI/Unpaywall
  // kesin eşleşmesi. LibGen/PMC/Sci-Hub gibi bulanık başlık aramaları hâlâ yok.
  if (journal && turkish) {
    const dergiFirst = ids.filter(
      (id) => id === "dergipark" || (id === "doi" && hasDoi),
    );
    return moveToFrontAfterLocal(dergiFirst, "dergipark");
  }

  // Tez → yalnızca YÖKTez (local/proxy/LibGen vb. aranmaz).
  if (isThesis(item)) {
    return ids.filter((id) => id === "yoktez");
  }

  if (article) {
    const allow = new Set<string>(["local", ...ARTICLE_DATABASE_IDS]);
    if (!turkish) allow.add("libgen");
    ids = ids.filter((id) => allow.has(id));

    if (hasDoi && ids.includes("doi")) {
      ids = moveToFrontAfterLocal(ids, "doi");
    }
    if (hasDoi && ids.includes("scihub")) {
      ids = moveToFrontAfterLocal(ids, "scihub");
      // Keep Unpaywall before Sci-Hub when both present.
      if (ids.includes("doi")) {
        ids = moveToFrontAfterLocal(ids, "doi");
      }
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

  if (hasDoi && ids.includes("doi")) {
    ids = moveToFrontAfterLocal(ids, "doi");
  }
  if (hasDoi && ids.includes("scihub")) {
    ids = moveToFrontAfterLocal(ids, "scihub");
    if (ids.includes("doi")) {
      ids = moveToFrontAfterLocal(ids, "doi");
    }
  }
  return ids;
}
