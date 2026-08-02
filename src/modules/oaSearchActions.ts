// @ajan: cursor · @etiket: katman-2, oa-search, actions, skip-validate
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
export function createItemFieldsFromHit(hit: OaPdfHit): ItemFieldsFromHit {
  const title = String(hit.title || "").trim() || "Untitled";
  const DOI = String(hit.doi || "").trim();
  const ISBN = hitIsbn(hit);
  const date = String(hit.year || "").trim();
  const url = String(hit.landingUrl || hit.pdfUrl || "").trim();
  return {
    itemType: guessItemTypeFromHit(hit),
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
  const url = String(hit.pdfUrl || "").trim();
  if (!url) return false;
  const sourceId = String(hit.source || "oa").trim() || "oa";
  const { downloadAndAttach, rethrowAttachControlFlow } =
    await import("./pdfSources");
  try {
    const bytes = await fetchOaPdfViaBridge({
      source: sourceId,
      pdfUrl: url,
      extra: {
        ...((hit.extra || {}) as Record<string, unknown>),
        landingUrl: hit.landingUrl || undefined,
        pdfUrl: url,
      },
    });
    if (!bytes) return false;
    // Explicit OA Search pick — trust like attachPdfFromUrl (validate: false).
    // Otherwise content validation can attach then eraseTx → "Could not attach".
    const att = await downloadAndAttach(item, url, {
      sourceId,
      bytes,
      validate: false,
    });
    return !!att;
  } catch (e) {
    rethrowAttachControlFlow(e);
    ztoolkit.log("oaSearch attachHitToItem failed", e);
    return false;
  }
}

/**
 * Create a regular item from hit metadata.
 * When attachPdf is true (default), also attach the hit PDF to the new item.
 */
export async function createItemFromHit(
  hit: OaPdfHit,
  libraryID: number,
  opts: { attachPdf?: boolean } = {},
): Promise<Zotero.Item> {
  const fields = createItemFieldsFromHit(hit);
  const item = new Zotero.Item(fields.itemType as any);
  item.libraryID = libraryID;
  safeSetField(item, "title", fields.title);
  safeSetField(item, "DOI", fields.DOI);
  safeSetField(item, "ISBN", fields.ISBN);
  safeSetField(item, "date", fields.date);
  safeSetField(item, "url", fields.url);
  if (fields.creators.length) {
    item.setCreators(fields.creators as any);
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
