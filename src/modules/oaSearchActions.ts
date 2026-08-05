// @ajan: cursor · @etiket: katman-2, oa-search, actions, attach-fallback
/**
 * OA Search popup actions: attach hit PDF, create item from hit, Related Items.
 * Pure field mapping is unit-tested; Zotero I/O stays async.
 * User-picked hits skip content validation (same trust as manual URL paste).
 */
import type { OaPdfHit } from "./oaPdfBridge";
import { fetchOaPdfViaBridge } from "./oaPdfBridge";

export type CreatorField = {
  firstName: string;
  lastName: string;
  creatorType: string;
};

export type ItemFieldsFromHit = {
  itemType: string;
  title: string;
  DOI: string;
  ISBN: string;
  date: string;
  url: string;
  creators: CreatorField[];
};

/** Stable unordered pair for Related Items assertions. */
export function relatedPairIds(aId: number, bId: number): [number, number] {
  return aId <= bId ? [aId, bId] : [bId, aId];
}

function hitIsbn(hit: OaPdfHit): string {
  const extra = (hit.extra || {}) as Record<string, unknown>;
  return String(extra.isbn || extra.ISBN || "")
    .replace(/[^0-9Xx]/g, "")
    .trim();
}

export function guessItemTypeFromHit(hit: OaPdfHit): string {
  const source = String(hit.source || "")
    .toLowerCase()
    .trim();
  if (
    source === "yoktez" ||
    source.includes("tez") ||
    source.includes("thesis")
  ) {
    return "thesis";
  }
  if (hitIsbn(hit)) return "book";
  if (String(hit.doi || "").trim()) return "journalArticle";
  if (source === "libgen" || source === "book" || source.includes("isbn")) {
    return "book";
  }
  return "journalArticle";
}

export function parseAuthorsField(
  authors: string | null | undefined,
): CreatorField[] {
  const raw = String(authors || "").trim();
  if (!raw) return [];
  const parts = raw.split(/\s*;\s*|\s+and\s+/i);
  const out: CreatorField[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes(",")) {
      const [last, ...rest] = p.split(",");
      out.push({
        firstName: rest.join(",").trim(),
        lastName: last.trim(),
        creatorType: "author",
      });
      continue;
    }
    const bits = p.split(/\s+/).filter(Boolean);
    if (bits.length === 1) {
      out.push({ firstName: "", lastName: bits[0], creatorType: "author" });
    } else {
      out.push({
        firstName: bits.slice(0, -1).join(" "),
        lastName: bits[bits.length - 1],
        creatorType: "author",
      });
    }
  }
  return out;
}

/** Pure: map OA hit → Zotero field bag (no I/O). */
export function createItemFieldsFromHit(
  hit: OaPdfHit,
  opts: { preferredItemType?: string } = {},
): ItemFieldsFromHit {
  const title = String(hit.title || "").trim() || "Untitled";
  const DOI = String(hit.doi || "").trim();
  const ISBN = hitIsbn(hit);
  const date = String(hit.year || "").trim();
  const url = String(hit.landingUrl || hit.pdfUrl || "").trim();
  const preferred = String(opts.preferredItemType || "").trim();
  return {
    itemType: preferred || guessItemTypeFromHit(hit),
    title,
    DOI,
    ISBN,
    date,
    url,
    creators: parseAuthorsField(hit.authors),
  };
}

function safeSetField(item: Zotero.Item, field: string, value: string): void {
  const v = String(value || "").trim();
  if (!v) return;
  try {
    item.setField(field as any, v);
  } catch {
    /* field may not exist on this item type */
  }
}

export async function attachHitToItem(
  item: Zotero.Item,
  hit: OaPdfHit,
): Promise<boolean> {
  const result = await attachHitToItemDetailed(item, hit);
  return result.ok;
}

export function isRetryableOaFetchError(msg: string): boolean {
  const m = String(msg || "").toLowerCase();
  if (!m.trim()) return false;
  return /502|503|504|timeout|timed out|fetch|köprü|bridge returned no pdf|alınamadı|bad gateway|gateway time/.test(
    m,
  );
}

export function fallbackHitsForAttach(
  selected: OaPdfHit,
  all: OaPdfHit[],
): OaPdfHit[] {
  const selUrl = String(selected?.pdfUrl || "").trim();
  const selSrc = String(selected?.source || "").toLowerCase();
  const rest = (all || []).filter((h) => {
    const url = String(h?.pdfUrl || "").trim();
    if (!url) return false;
    if (h === selected) return false;
    if (String(h.source || "").toLowerCase() === selSrc && url === selUrl) {
      return false;
    }
    return true;
  });
  const weight = (h: OaPdfHit) => {
    const s = String(h.source || "").toLowerCase();
    if (s === "dergipark") return 0;
    if (s === "pmc") return 1;
    if (s === "doi") return 2;
    return 3;
  };
  return [...rest].sort((a, b) => weight(a) - weight(b));
}

/** Same as attachHitToItem but keeps the failure reason for OA Search status. */
export async function attachHitToItemDetailed(
  item: Zotero.Item,
  hit: OaPdfHit,
  opts?: { fallbackHits?: OaPdfHit[] },
): Promise<{ ok: boolean; error?: string }> {
  const queue = [hit, ...fallbackHitsForAttach(hit, opts?.fallbackHits || [])];
  let lastError = "";
  for (const cand of queue) {
    const result = await attachOneHit(item, cand);
    if (result.ok) return result;
    lastError = result.error || lastError;
    if (!isRetryableOaFetchError(lastError)) return result;
  }
  return { ok: false, error: lastError || "attach failed" };
}

async function attachOneHit(
  item: Zotero.Item,
  hit: OaPdfHit,
): Promise<{ ok: boolean; error?: string }> {
  const url = String(hit.pdfUrl || "").trim();
  const landing = String(hit.landingUrl || "").trim();
  if (!url && !landing) {
    return { ok: false, error: "no pdfUrl/landingUrl on hit" };
  }
  const sourceId = String(hit.source || "oa").trim() || "oa";
  const { downloadAndAttach, rethrowAttachControlFlow } =
    await import("./pdfSources");
  const extraBase = {
    ...((hit.extra || {}) as Record<string, unknown>),
    landingUrl: landing || undefined,
    pdfUrl: url || undefined,
  };
  try {
    let bytes = await fetchOaPdfViaBridge({
      source: sourceId,
      pdfUrl: url || landing,
      extra: extraBase,
      label: String(hit.title || item.getDisplayTitle() || "").trim(),
    });
    // Landing-only / HTML pdfUrl: one more try with explicit landing scrape.
    if (!bytes && landing && landing !== url) {
      bytes = await fetchOaPdfViaBridge({
        source: sourceId,
        pdfUrl: landing,
        extra: { ...extraBase, landingUrl: landing },
        label: String(hit.title || item.getDisplayTitle() || "").trim(),
      });
    }
    if (!bytes) {
      return {
        ok: false,
        error: "bridge returned no PDF bytes (%PDF gate)",
      };
    }
    // Explicit OA Search pick — trust like attachPdfFromUrl (validate: false).
    const att = await downloadAndAttach(item, url || landing, {
      sourceId,
      bytes,
      validate: false,
    });
    if (!att) {
      return {
        ok: false,
        error: "downloadAndAttach returned null (disk/link)",
      };
    }
    return { ok: true };
  } catch (e) {
    rethrowAttachControlFlow(e);
    const msg = e instanceof Error ? e.message : String(e);
    ztoolkit.log("oaSearch attachHitToItem failed", e);
    return { ok: false, error: msg };
  }
}

/**
 * Create a regular item from hit metadata.
 * When attachPdf is true (default), also attach the hit PDF to the new item.
 */
export async function createItemFromHit(
  hit: OaPdfHit,
  libraryID: number,
  opts: {
    attachPdf?: boolean;
    preferredItemType?: string;
    bookTitle?: string;
    publication?: string;
    publisher?: string;
    university?: string;
    language?: string;
    thesisType?: string;
    editors?: string;
    translator?: string;
  } = {},
): Promise<Zotero.Item> {
  const fields = createItemFieldsFromHit(hit, {
    preferredItemType: opts.preferredItemType,
  });
  const item = new Zotero.Item(fields.itemType as any);
  item.libraryID = libraryID;
  safeSetField(item, "title", fields.title);
  safeSetField(item, "DOI", fields.DOI);
  safeSetField(item, "ISBN", fields.ISBN);
  safeSetField(item, "date", fields.date);
  safeSetField(item, "url", fields.url);
  safeSetField(item, "bookTitle", String(opts.bookTitle || "").trim());
  safeSetField(item, "publicationTitle", String(opts.publication || "").trim());
  safeSetField(item, "publisher", String(opts.publisher || "").trim());
  safeSetField(item, "university", String(opts.university || "").trim());
  safeSetField(item, "language", String(opts.language || "").trim());
  safeSetField(item, "thesisType", String(opts.thesisType || "").trim());
  const creators = [...fields.creators];
  if (opts.editors?.trim()) {
    for (const c of parseAuthorsField(opts.editors)) {
      creators.push({ ...c, creatorType: "editor" });
    }
  }
  if (opts.translator?.trim()) {
    for (const c of parseAuthorsField(opts.translator)) {
      creators.push({ ...c, creatorType: "translator" });
    }
  }
  if (creators.length) {
    item.setCreators(creators as any);
  }
  item.addTag("#oa-search");
  await item.saveTx();
  if (opts.attachPdf !== false && String(hit.pdfUrl || "").trim()) {
    await attachHitToItem(item, hit);
  }
  return item;
}

/** Bidirectional Related Items link. */
export async function linkRelated(
  a: Zotero.Item,
  b: Zotero.Item,
): Promise<boolean> {
  if (!a?.id || !b?.id || a.id === b.id) return false;
  try {
    const related = (a as any).relatedItems || [];
    if (Array.isArray(related) && related.includes(b.key)) return false;
  } catch {
    /* ignore */
  }
  a.addRelatedItem(b);
  b.addRelatedItem(a);
  await a.saveTx({ skipSelect: true } as any);
  await b.saveTx({ skipSelect: true } as any);
  return true;
}

/**
 * Seçiliye ekle + Related:
 * (1) new metadata item from hit, (2) PDF on selected, (3) Related link.
 */
export async function attachToSelectedWithRelated(
  selected: Zotero.Item,
  hit: OaPdfHit,
): Promise<{ attachmentOk: boolean; relatedItem: Zotero.Item | null }> {
  const relatedItem = await createItemFromHit(hit, selected.libraryID, {
    attachPdf: false,
  });
  const attachmentOk = await attachHitToItem(selected, hit);
  await linkRelated(selected, relatedItem);
  return { attachmentOk, relatedItem };
}
