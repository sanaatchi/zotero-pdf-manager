// @ajan: cursor · @etiket: katman-2, pdf-metadata, max-path
import { PDFDocument, PDFName } from "pdf-lib";
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";

declare const IOUtils: any;

/**
 * Sibling temp path for atomic PDF rewrite.
 *
 * Must stay SHORT: `${pdfPath}.zpdfmanager.tmp` on a near-Windows-MAX_PATH
 * (~260) linked file exceeds the limit and IOUtils.write fails with
 * NS_ERROR_FILE_NOT_FOUND even though the PDF itself is readable. Same
 * directory keeps the rename atomic on one volume.
 */
export function metadataEmbedTmpPath(
  pdfPath: string,
  attachmentKey: string,
): string {
  const key = String(attachmentKey || "tmp").replace(/[^\w-]/g, "") || "tmp";
  const lastSlash = Math.max(
    pdfPath.lastIndexOf("/"),
    pdfPath.lastIndexOf("\\"),
  );
  if (lastSlash < 0) return `.zpm-${key}.tmp`;
  return `${pdfPath.slice(0, lastSlash)}${pdfPath[lastSlash]}.zpm-${key}.tmp`;
}

// pdf-lib's own parser calls console.warn/log for recoverable issues it hits
// in slightly malformed real-world PDFs (bad object refs, XFA form data, …).
// Zotero's bootstrapped extension scope has no global `console`, so those
// calls throw "console is not defined" and abort the whole embed — even
// though pdf-lib itself was only trying to log a warning, not fail. Route
// them to the addon's own logger instead of leaving them unhandled.
if (typeof (globalThis as any).console === "undefined") {
  (globalThis as any).console = {
    log: (...args: unknown[]) => ztoolkit.log("[pdf-lib]", ...args),
    warn: (...args: unknown[]) => ztoolkit.log("[pdf-lib:warn]", ...args),
    error: (...args: unknown[]) => ztoolkit.log("[pdf-lib:error]", ...args),
  };
}

export function escapeXml(value: string): string {
  return String(value).replace(
    /[<>&'"]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[c] as string,
  );
}

// --- XMP element builders (mixed namespaces, so no shared prefix) ----------

/** A localized text property: dc:title / dc:description. */
export function xmpAlt(tag: string, value: string): string {
  return value
    ? `   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li></rdf:Alt></${tag}>\n`
    : "";
}

/** An unordered array: dc:subject, dc:publisher, dc:language, dc:type. */
export function xmpBag(tag: string, values: string[]): string {
  if (!values.length) return "";
  const items = values
    .map((value) => `<rdf:li>${escapeXml(value)}</rdf:li>`)
    .join("");
  return `   <${tag}><rdf:Bag>${items}</rdf:Bag></${tag}>\n`;
}

/** An ordered array: dc:creator, dc:date. */
export function xmpSeq(tag: string, values: string[]): string {
  if (!values.length) return "";
  const items = values
    .map((value) => `<rdf:li>${escapeXml(value)}</rdf:li>`)
    .join("");
  return `   <${tag}><rdf:Seq>${items}</rdf:Seq></${tag}>\n`;
}

/** A single-value property: zotero:*, pdf:*, xmp:*, dc:identifier. */
export function xmpSimple(tag: string, value: string): string {
  return value ? `   <${tag}>${escapeXml(value)}</${tag}>\n` : "";
}

/** Custom namespace that mirrors Zotero fields 1:1 (type-specific names). */
const ZOTERO_XMP_NS = "http://zotero-pdf-manager/zotero-fields/1.0/";

/**
 * Write the metadata into the PDF's XMP stream as well as the Info dictionary.
 * pdf-lib's setTitle/etc. only touch the legacy Info dictionary; most modern
 * metadata editors (Adobe, exiftool, Explorer) read the XMP packet, so without
 * this the embedded metadata looks "missing" in those tools.
 *
 * Two layers:
 *   1. Dublin Core / PDF / XMP — only fields with a genuine 1:1 standard
 *      equivalent (title, creator, publisher, date, language, …). No loose
 *      mappings like bookTitle→dc:source.
 *   2. zotero: namespace — every non-empty type-specific field and every
 *      creator type exactly as in the Zotero schema (bookTitle, place,
 *      zotero:editor, zotero:translator, …).
 */
function embedXmpMetadata(
  pdf: PDFDocument,
  metadata: ReturnType<typeof metadataFromItem>,
) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const createDate = metadata.year
    ? new Date(Date.UTC(metadata.year, 0, 1))
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z")
    : "";
  const identifier = metadata.doi
    ? `doi:${metadata.doi}`
    : metadata.isbn
      ? `urn:isbn:${metadata.isbn}`
      : "";

  const zoteroBlock =
    xmpSimple("zotero:itemType", metadata.itemTypeKey) +
    metadata.zoteroFields
      .map(({ name, value }) => xmpSimple(`zotero:${name}`, value))
      .join("") +
    metadata.creatorGroups
      .map(({ type, names }) => xmpSeq(`zotero:${type}`, names))
      .join("") +
    xmpBag("zotero:tags", metadata.keywords);

  const body =
    // Dublin Core — exact-equivalent fields only (broad tool compatibility).
    xmpAlt("dc:title", metadata.title) +
    xmpSeq("dc:creator", metadata.authors) +
    xmpBag("dc:contributor", metadata.contributors) +
    xmpAlt("dc:description", metadata.abstract) +
    xmpBag("dc:subject", metadata.keywords) +
    xmpBag("dc:publisher", metadata.publisher ? [metadata.publisher] : []) +
    xmpSeq("dc:date", metadata.date ? [metadata.date] : []) +
    xmpBag("dc:language", metadata.language ? [metadata.language] : []) +
    xmpSimple("dc:identifier", identifier) +
    xmpBag("dc:type", metadata.itemType ? [metadata.itemType] : []) +
    xmpSimple("dc:rights", metadata.rights) +
    // Full 1:1 Zotero mirror (bookTitle, editor, translator, place, …).
    zoteroBlock +
    // PDF schema — mirrors the Info dictionary for XMP-only readers.
    xmpSimple(
      "pdf:Keywords",
      metadata.keywords.length ? metadata.keywords.join(", ") : "",
    ) +
    xmpSimple("pdf:Producer", metadata.publisher) +
    // XMP basic — the tool that wrote this and when.
    xmpSimple("xmp:CreatorTool", config.addonName) +
    xmpSimple("xmp:CreateDate", createDate) +
    xmpSimple("xmp:MetadataDate", now) +
    xmpSimple("xmp:ModifyDate", now);

  const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:zotero="${ZOTERO_XMP_NS}"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/">
${body}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  // Encode as UTF-8 bytes — passing a string lets pdf-lib write each code
  // unit as one byte, corrupting non-Latin1 characters (Turkish ı/ğ/ş, etc.).
  const stream = pdf.context.stream(new TextEncoder().encode(xmp), {
    Type: PDFName.of("Metadata"),
    Subtype: PDFName.of("XML"),
  });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(stream));
}

function creatorName(creator: any) {
  return (
    creator.name ||
    [creator.firstName, creator.lastName].filter(Boolean).join(" ")
  ).trim();
}

/**
 * Split an item's creators for both DC and the 1:1 zotero: namespace.
 *
 * Primary creator type (author for most types; artist/director/… for others)
 * → dc:creator / PDF Author. Non-primary:
 *   - "editor"      → kept out of dc:contributor (lives in zotero:editor)
 *   - "contributor" → dc:contributor (plain name; Zotero "Katkıda bulunan")
 *   - anything else → dc:contributor with a localized role label so the role
 *     isn't lost in the flat DC list
 *
 * `groups` holds every creator under their exact Zotero type name for
 * zotero:author / zotero:editor / zotero:translator / …
 */
function splitCreators(item: Zotero.Item) {
  const creators = ((item as any).getCreators?.() || []) as any[];
  let primaryTypeID: number | null = null;
  try {
    primaryTypeID = (Zotero as any).CreatorTypes?.getPrimaryIDForType?.(
      (item as any).itemTypeID,
    );
  } catch {
    primaryTypeID = null;
  }
  const typeName = (id: number) => {
    try {
      return (Zotero as any).CreatorTypes?.getName?.(id) || "";
    } catch {
      return "";
    }
  };
  // Localized role label ("Çevirmen", "Dizi Editörü", …) in the Zotero locale.
  const roleLabel = (id: number) => {
    try {
      return (Zotero as any).CreatorTypes?.getLocalizedString?.(id) || "";
    } catch {
      return "";
    }
  };
  const primary: string[] = [];
  const editors: string[] = [];
  const contributors: string[] = [];
  const all: string[] = [];
  // Creators grouped by their EXACT Zotero creator-type name, for the 1:1
  // zotero: namespace (zotero:author, zotero:editor, zotero:translator, …).
  const groups = new Map<string, string[]>();
  for (const creator of creators) {
    const name = creatorName(creator);
    if (!name) continue;
    all.push(name);

    const type = typeName(creator.creatorTypeID) || "contributor";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(name);

    if (primaryTypeID != null && creator.creatorTypeID === primaryTypeID) {
      primary.push(name);
      continue;
    }
    if (type === "editor") {
      editors.push(name);
    } else if (type === "contributor") {
      // Zotero's own "contributor" (Katkıda bulunan) → plain name; the field is
      // already called Contributors, so no role suffix needed.
      contributors.push(name);
    } else {
      const role = roleLabel(creator.creatorTypeID);
      contributors.push(role ? `${name} (${role})` : name);
    }
  }
  return {
    primary,
    editors,
    contributors,
    all,
    groups: [...groups.entries()].map(([type, names]) => ({ type, names })),
  };
}

/**
 * Automation/bookkeeping tags the plugin (or its Attanger heritage) adds are
 * not real subject keywords — keep them out of the embedded metadata.
 * Everything hash-prefixed plus the known internal namespaces is dropped.
 */
export function isSystemTag(tag: string): boolean {
  return (
    tag.startsWith("#") ||
    /^(MetadataHunter|ZPDF)\b/i.test(tag) ||
    /^YÖK Tez No:/i.test(tag)
  );
}

/** First 4-digit year found in a Zotero date string ("1997", "2020-03"…). */
export function parseYear(raw: string): number | null {
  const match = raw.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

/**
 * Every non-empty field valid for this item's type, under the exact
 * type-specific name from the Zotero schema (bookTitle, university,
 * proceedingsTitle, … — never the base-field alias).
 * @see https://api.zotero.org/schema
 */
function collectTypeFields(
  item: Zotero.Item,
): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  let names: string[] = [];
  try {
    const ids =
      (Zotero as any).ItemFields?.getItemTypeFields?.(
        (item as any).itemTypeID,
      ) || [];
    names = ids
      .map((id: number) => (Zotero as any).ItemFields?.getName?.(id) || "")
      .filter(Boolean);
  } catch {
    names = [];
  }
  for (const name of names) {
    try {
      // includeBaseMapped=false: read by the exact type-specific name only.
      const value = String(
        (item as any).getField(name, false, false) || "",
      ).trim();
      if (value) out.push({ name, value });
    } catch {
      // Field not readable for this item; skip.
    }
  }
  return out;
}

function metadataFromItem(item: Zotero.Item) {
  // includeBaseMapped=true resolves a base field to the type-specific field
  // that maps to it — used only for the few DC/Info slots that have a real
  // 1:1 equivalent (publisher→university for thesis, etc.). Container titles
  // (bookTitle / publicationTitle / …) are NOT base-mapped into a shared
  // standard field; they live only under their exact name in zotero:*.
  const field = (name: string) => {
    try {
      return String((item as any).getField(name, false, true) || "").trim();
    } catch {
      return "";
    }
  };

  const {
    primary,
    editors,
    contributors: nonPrimaryContributors,
    all: allCreators,
    groups,
  } = splitCreators(item);

  const tags = (((item as any).getTags?.() || []) as any[])
    .map((tag) => (typeof tag === "string" ? tag : tag.tag))
    .filter((tag): tag is string => Boolean(tag) && !isSystemTag(tag));

  const date = field("date");

  // dc:creator / PDF Author: the primary creators; if the item has none, fall
  // back to every creator so an edited volume listing only editors still gets
  // an author.
  const authorsForField = primary.length ? primary : allCreators;
  // Info "Creator" = first primary creator, or first editor when there is no
  // primary one (user mapping: "Creator: ilk yazar ya da editör").
  const primaryCreator = primary[0] || editors[0] || allCreators[0] || "";
  // dc:contributor = Zotero "contributor" (+ other non-editor roles, labelled).
  // Editors are intentionally excluded — they live in zotero:editor. When there
  // is no primary creator the same people already fill dc:creator, so skip.
  const contributors = primary.length ? nonPrimaryContributors : [];

  let itemTypeName = "";
  let itemTypeKey = "";
  try {
    itemTypeKey =
      (Zotero as any).ItemTypes?.getName?.((item as any).itemTypeID) || "";
    itemTypeName =
      (Zotero as any).ItemTypes?.getLocalizedString?.(
        (item as any).itemTypeID,
      ) || itemTypeKey;
  } catch {
    itemTypeName = "";
    itemTypeKey = "";
  }

  return {
    title: field("title") || item.getDisplayTitle() || "",
    authors: authorsForField,
    contributors,
    editors,
    // Info "Producer" = publisher (user mapping). Base-mapped so
    // thesis→university, report→institution, film→distributor, etc.
    publisher: field("publisher"),
    primaryCreator,
    date,
    year: parseYear(date),
    language: field("language"),
    doi: field("DOI"),
    isbn: field("ISBN"),
    rights: field("rights"),
    abstract: field("abstractNote"),
    itemType: itemTypeName,
    itemTypeKey,
    // Exact schema dump for the zotero: XMP namespace.
    zoteroFields: collectTypeFields(item),
    creatorGroups: groups,
    keywords: tags,
  };
}

export async function embedMetadataIntoAttachment(
  item: Zotero.Item,
  attachment: Zotero.Item,
) {
  const path = await attachment.getFilePathAsync();
  if (!path) {
    throw new Error(
      "Dosya yolu çözülemedi (getFilePathAsync boş) — ek eksik, bağlı dosya taşınmış/silinmiş veya OneDrive henüz indirmemiş olabilir",
    );
  }
  const ext = Zotero.File.getExtension(path).toLowerCase();
  if (ext !== "pdf") throw new Error(`PDF değil (uzantı: .${ext || "?"})`);
  if (!(await IOUtils.exists(path))) {
    throw new Error(`Dosya diskte bulunamadı: ${path}`);
  }

  // Copy Zotero's cross-compartment typed array into the extension realm;
  // pdf-lib otherwise fails its Uint8Array type check.
  const bytes = Uint8Array.from(
    (await IOUtils.read(path)) as ArrayLike<number>,
  );
  // Do NOT use `ignoreEncryption: true` here. pdf-lib has no real decryption
  // support — even for the common case of an owner-password-only PDF (no open
  // password, just print/copy restrictions), loading with ignoreEncryption and
  // re-saving silently corrupts the file: the trailer/catalog/content streams
  // come back unreadable (verified empirically — pdftotext could no longer
  // even find the trailer after such a round-trip). Since no backup is kept,
  // that would be irreversible. Encrypted PDFs are skipped instead, with a
  // distinct message, until a safe decrypt path exists.
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    if (/encrypt/i.test(message)) {
      throw new Error(
        "Şifreli PDF: içerik bozulma riski nedeniyle metadata gömülmedi (pdf-lib şifre çözmeyi desteklemiyor)",
      );
    }
    throw error;
  }
  const metadata = metadataFromItem(item);
  // Write EVERY managed Info field unconditionally — Zotero is the source of
  // truth. Setting empty values when the item has no data is deliberate: it
  // wipes stale values left by a previous embedding (e.g. an old overloaded
  // Subject or a system-tag Keyword) instead of leaving them behind.
  pdf.setTitle(metadata.title);
  pdf.setAuthor(metadata.authors.join("; "));
  // Subject holds the abstract only — type-specific fields (bookTitle, DOI,
  // place, …) live in the zotero: XMP namespace, not overloaded into Subject.
  pdf.setSubject(metadata.abstract);
  // Copy into THIS realm's Array of strings (empty array clears old keywords).
  // Zotero's getTags() returns a cross-compartment array, which pdf-lib's
  // assertIs rejects (reporting a bogus "NaN" type) — same cross-realm issue
  // handled for the bytes above.
  pdf.setKeywords(Array.from(metadata.keywords, (k) => String(k)));
  // User field mapping: Creator = first author/editor, Producer = publisher.
  pdf.setCreator(metadata.primaryCreator);
  pdf.setProducer(metadata.publisher);
  if (metadata.year) {
    pdf.setCreationDate(new Date(Date.UTC(metadata.year, 0, 1)));
  }
  pdf.setModificationDate(new Date());

  // Also write the XMP packet so XMP-based editors (Adobe, exiftool, Explorer)
  // show the metadata — not just the legacy Info dictionary.
  embedXmpMetadata(pdf, metadata);

  const output = await pdf.save();
  // No permanent backup (user preference). The tmpPath write is still atomic
  // — it writes to a temporary file and renames, so a failed/partial write
  // never leaves a corrupted original. Short sibling name avoids Windows
  // MAX_PATH when the PDF filename is already near 260 characters.
  const attachmentKey = String(
    (attachment as any).key || attachment.id || "tmp",
  );
  await IOUtils.write(path, output, {
    tmpPath: metadataEmbedTmpPath(path, attachmentKey),
  });

  try {
    await (Zotero.Fulltext as any).indexItems([attachment.id]);
  } catch (error) {
    ztoolkit.log("PDF metadata written, but reindex failed", error);
  }
  return true;
}

export async function maybeEmbedMetadata(
  item: Zotero.Item,
  attachment: Zotero.Item,
) {
  if (!getPref("pdf.embedMetadataAutomatically")) return false;
  // Never rewrite the user's original (linked) files automatically — only
  // PDFs stored inside Zotero. The manual command still handles linked files.
  const linkMode = (attachment as any).attachmentLinkMode;
  if (linkMode === (Zotero.Attachments as any).LINK_MODE_LINKED_FILE) {
    return false;
  }
  try {
    return await embedMetadataIntoAttachment(item, attachment);
  } catch (error) {
    ztoolkit.log("Automatic PDF metadata embedding failed", error);
    return false;
  }
}

// Persisted across sessions as ordinary Zotero tags (same pattern as the
// reconciler's #auto-attached/#broken) so "only missing/failed" can tell,
// without re-touching every PDF, which items already have current metadata.
const TAG_METADATA_EMBEDDED = "#metadata-embedded";
const TAG_METADATA_FAILED = "#metadata-failed";

/**
 * Collapse a list of per-attachment embed results into one outcome per
 * parent item (keyed by item.id, stable across separate attachment pairs
 * that share a parent), pure so it's directly unit-testable. An item is
 * "allSucceeded" only if every attachment processed for it in this run
 * succeeded — one failure among several attachments must not be masked by an
 * earlier or later success for the same item.
 */
export function aggregateItemOutcomes<T extends { id: number }>(
  results: Array<{ item: T; succeeded: boolean }>,
): Map<number, { item: T; allSucceeded: boolean }> {
  const outcomes = new Map<number, { item: T; allSucceeded: boolean }>();
  for (const { item, succeeded } of results) {
    const existing = outcomes.get(item.id);
    outcomes.set(item.id, {
      item,
      allSucceeded: (existing?.allSucceeded ?? true) && succeeded,
    });
  }
  return outcomes;
}

async function setEmbedStatusTag(item: Zotero.Item, success: boolean) {
  try {
    const tags = ((item.getTags() as { tag: string }[]) || []).map(
      (t) => t.tag,
    );
    const toAdd = success ? TAG_METADATA_EMBEDDED : TAG_METADATA_FAILED;
    const toRemove = success ? TAG_METADATA_FAILED : TAG_METADATA_EMBEDDED;
    let changed = false;
    if (!tags.includes(toAdd)) {
      item.addTag(toAdd);
      changed = true;
    }
    if (tags.includes(toRemove)) {
      item.removeTag(toRemove);
      changed = true;
    }
    if (changed) await item.saveTx();
  } catch (e) {
    ztoolkit.log("Could not update metadata embed status tag", e);
  }
}

/**
 * Ground truth for "already embedded", read from the PDF itself rather than
 * a Zotero tag. Every version of embedXmpMetadata (since XMP support was
 * added) unconditionally writes xmp:CreatorTool = config.addonName — so its
 * presence in the XMP packet reliably marks a prior embed regardless of which
 * plugin version wrote it. Tags alone can't tell this: they were only
 * introduced in 1.0.16, so PDFs embedded by earlier versions have no tag yet
 * even though they already carry current metadata.
 */
async function hasEmbeddedMetadataMarker(
  attachment: Zotero.Item,
): Promise<boolean> {
  try {
    const path = await attachment.getFilePathAsync();
    if (!path) return false;
    const bytes = Uint8Array.from(
      (await IOUtils.read(path)) as ArrayLike<number>,
    );
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const metaRef = pdf.catalog.get(PDFName.of("Metadata"));
    if (!metaRef) return false;
    const stream: any = pdf.context.lookup(metaRef);
    const xmpBytes = stream?.contents ?? stream?.getContents?.();
    if (!xmpBytes) return false;
    const xmpText = new TextDecoder("utf-8").decode(xmpBytes);
    return xmpText.includes(
      `<xmp:CreatorTool>${escapeXml(config.addonName)}</xmp:CreatorTool>`,
    );
  } catch {
    // Can't read it (encrypted, corrupt, missing) — treat as "not embedded"
    // so it surfaces in the failed/missing run rather than being silently
    // skipped by the marker check itself.
    return false;
  }
}

function collectSelectedPdfPairs() {
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
      continue;
    }
    if (!selected.isRegularItem()) continue;
    for (const attachmentID of selected.getAttachments()) {
      const attachment = Zotero.Items.get(attachmentID);
      if (
        attachment?.isAttachment() &&
        attachment.attachmentContentType === "application/pdf"
      ) {
        pairs.set(attachment.id, { item: selected, attachment });
      }
    }
  }
  return pairs;
}

/**
 * Shared runner behind both menu commands.
 * - onlyMissingOrFailed=false: force-refresh every selected PDF, regardless
 *   of prior state (already embedded, previously failed, or untouched).
 * - onlyMissingOrFailed=true: skip PDFs that already carry our metadata
 *   marker (checked in the PDF itself, not a tag — see
 *   hasEmbeddedMetadataMarker) — only (re)tries items that were never
 *   embedded or previously failed, no matter which plugin version embedded
 *   the ones that already succeeded.
 */
async function runEmbedMetadata(onlyMissingOrFailed: boolean) {
  const pairs = collectSelectedPdfPairs();

  let candidates = [...pairs.values()];
  let alreadyEmbedded = 0;
  if (onlyMissingOrFailed) {
    const checked = await Promise.all(
      candidates.map(async (pair) => ({
        pair,
        done: await hasEmbeddedMetadataMarker(pair.attachment),
      })),
    );
    candidates = checked.filter(({ done }) => !done).map(({ pair }) => pair);
    alreadyEmbedded = checked.length - candidates.length;
  }

  if (!candidates.length) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
      .createLine({
        text:
          onlyMissingOrFailed && alreadyEmbedded
            ? `Tüm seçili kaynaklarda metadata zaten güncel (${alreadyEmbedded})`
            : "PDF'li kaynak seçilmedi",
        type: "default",
      })
      .show();
    return;
  }

  let success = 0;
  const failures: string[] = [];
  const results: Array<{ item: Zotero.Item; succeeded: boolean }> = [];
  for (const { item, attachment } of candidates) {
    let succeeded: boolean;
    try {
      succeeded = await embedMetadataIntoAttachment(item, attachment);
      if (succeeded) {
        success++;
      } else {
        failures.push(`${item.getDisplayTitle()}: atlandı`);
      }
    } catch (error) {
      succeeded = false;
      const reason = (error as Error)?.message || String(error);
      failures.push(`${item.getDisplayTitle()}: ${reason}`);
      ztoolkit.log("PDF metadata embedding failed", attachment.id, error);
    }
    results.push({ item, succeeded });
  }
  // Aggregate per item rather than tagging after each attachment: an item
  // with 2+ PDF attachments previously got its tag overwritten by whichever
  // attachment was processed LAST, hiding an earlier failure once a later
  // attachment succeeded (or vice versa). The item is only tagged
  // #metadata-embedded if EVERY attachment processed for it this run
  // succeeded.
  for (const { item, allSucceeded } of aggregateItemOutcomes(
    results,
  ).values()) {
    await setEmbedStatusTag(item, allSucceeded);
  }
  const skippedNote =
    onlyMissingOrFailed && alreadyEmbedded
      ? ` (${alreadyEmbedded} zaten güncel, atlandı)`
      : "";
  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
    .createLine({
      text: `PDF metadata: ${success} güncellendi, ${failures.length} başarısız${skippedNote}`,
      type: success ? "success" : "default",
    })
    .show();
  // Surface the actual reasons so a failure is diagnosable, not silent.
  if (failures.length) {
    window.alert(
      `${config.addonName} — Metadata gömme\n\n` +
        `${success} başarılı, ${failures.length} başarısız:\n\n` +
        failures.slice(0, 30).join("\n"),
    );
  }
}

/** Force-refresh: (re)embeds every selected PDF regardless of prior state. */
export async function embedMetadataForSelectedItems() {
  await runEmbedMetadata(false);
}

/** Only (re)embeds PDFs with no current metadata: never-embedded or previously failed. */
export async function embedMetadataForFailedOrMissingSelectedItems() {
  await runEmbedMetadata(true);
}
