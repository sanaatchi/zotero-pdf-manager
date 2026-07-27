import { PDFDocument, PDFName } from "pdf-lib";
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";

declare const IOUtils: any;

function escapeXml(value: string): string {
  return String(value).replace(
    /[<>&'"]/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[
        c
      ] as string,
  );
}

// --- XMP element builders (mixed namespaces, so no shared prefix) ----------

/** A localized text property: dc:title / dc:description. */
function xmpAlt(tag: string, value: string): string {
  return value
    ? `   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li></rdf:Alt></${tag}>\n`
    : "";
}

/** An unordered array: dc:subject, dc:publisher, dc:language, dc:type. */
function xmpBag(tag: string, values: string[]): string {
  if (!values.length) return "";
  const items = values
    .map((value) => `<rdf:li>${escapeXml(value)}</rdf:li>`)
    .join("");
  return `   <${tag}><rdf:Bag>${items}</rdf:Bag></${tag}>\n`;
}

/** An ordered array: dc:creator, dc:date. */
function xmpSeq(tag: string, values: string[]): string {
  if (!values.length) return "";
  const items = values
    .map((value) => `<rdf:li>${escapeXml(value)}</rdf:li>`)
    .join("");
  return `   <${tag}><rdf:Seq>${items}</rdf:Seq></${tag}>\n`;
}

/** A single-value property: prism:*, pdf:*, xmp:*, dc:identifier. */
function xmpSimple(tag: string, value: string): string {
  return value ? `   <${tag}>${escapeXml(value)}</${tag}>\n` : "";
}

/**
 * Write the metadata into the PDF's XMP stream as well as the Info dictionary.
 * pdf-lib's setTitle/etc. only touch the legacy Info dictionary; most modern
 * metadata editors (Adobe, exiftool, Explorer) read the XMP packet, so without
 * this the embedded metadata looks "missing" in those tools.
 *
 * Only fields that actually carry data are emitted ("metadata verisi olan yer
 * oluşturulsun") across the Dublin Core, PRISM, PDF and XMP schemas.
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

  const body =
    // Dublin Core — the schema every editor understands.
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
    // PRISM — journal/serial specifics.
    xmpSimple("prism:publicationName", metadata.publicationTitle) +
    xmpSimple("prism:doi", metadata.doi) +
    xmpSimple("prism:isbn", metadata.isbn) +
    xmpSimple("prism:volume", metadata.volume) +
    xmpSimple("prism:number", metadata.issue) +
    xmpSimple("prism:pageRange", metadata.pages) +
    xmpSimple("prism:publicationDate", metadata.date) +
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

  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"
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

/** Names of the item's creators that have the given Zotero creator type. */
function creatorsByType(item: Zotero.Item, typeName: string): string[] {
  const creators = ((item as any).getCreators?.() || []) as any[];
  return creators
    .filter((creator) => {
      try {
        return (
          (Zotero as any).CreatorTypes?.getName?.(creator.creatorTypeID) ===
          typeName
        );
      } catch {
        return false;
      }
    })
    .map(creatorName)
    .filter(Boolean);
}

/**
 * Automation/bookkeeping tags the plugin (or its Attanger heritage) adds are
 * not real subject keywords — keep them out of the embedded metadata.
 * Everything hash-prefixed plus the known internal namespaces is dropped.
 */
function isSystemTag(tag: string): boolean {
  return (
    tag.startsWith("#") ||
    /^(MetadataHunter|ZPDF)\b/i.test(tag) ||
    /^YÖK Tez No:/i.test(tag)
  );
}

/** First 4-digit year found in a Zotero date string ("1997", "2020-03"…). */
function parseYear(raw: string): number | null {
  const match = raw.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function metadataFromItem(item: Zotero.Item) {
  const field = (name: string) => {
    try {
      return String((item as any).getField(name) || "").trim();
    } catch {
      // Not every field is valid for every item type; treat as absent.
      return "";
    }
  };

  const allCreators = (((item as any).getCreators?.() || []) as any[])
    .map(creatorName)
    .filter(Boolean);
  const authors = creatorsByType(item, "author");
  const editors = creatorsByType(item, "editor");

  const tags = (((item as any).getTags?.() || []) as any[])
    .map((tag) => (typeof tag === "string" ? tag : tag.tag))
    .filter((tag): tag is string => Boolean(tag) && !isSystemTag(tag));

  const date = field("date");

  // Author field / dc:creator: prefer real authors, but fall back to every
  // creator so an edited volume that lists only editors still gets an author.
  const authorsForField = authors.length ? authors : allCreators;
  // Info "Creator" = first author, or first editor when there is no author
  // (user mapping: "Creator: ilk yazar ya da editör").
  const primaryCreator = authors[0] || editors[0] || allCreators[0] || "";
  // Only expose editors as separate contributors when they are NOT already
  // standing in as the creator above.
  const contributors = authors.length ? editors : [];

  let itemTypeName = "";
  try {
    itemTypeName =
      (Zotero as any).ItemTypes?.getLocalizedString?.(
        (item as any).itemTypeID,
      ) || "";
  } catch {
    itemTypeName = "";
  }

  return {
    title: String(item.getField("title") || item.getDisplayTitle() || "").trim(),
    authors: authorsForField,
    contributors,
    // Info "Producer" = publisher (user mapping: "producer: yayınevi ya da
    // yayıncı"). Fall back to distributor/institution when there is no
    // publisher field for the item type.
    publisher: field("publisher") || field("distributor") || field("institution"),
    primaryCreator,
    date,
    year: parseYear(date),
    language: field("language"),
    doi: field("DOI"),
    isbn: field("ISBN"),
    publicationTitle: field("publicationTitle"),
    volume: field("volume"),
    issue: field("issue"),
    pages: field("pages"),
    abstract: field("abstractNote"),
    itemType: itemTypeName,
    keywords: tags,
  };
}

export async function embedMetadataIntoAttachment(
  item: Zotero.Item,
  attachment: Zotero.Item,
) {
  const path = await attachment.getFilePathAsync();
  if (!path) throw new Error("Dosya yolu çözülemedi (getFilePathAsync boş)");
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
  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: false,
  });
  const metadata = metadataFromItem(item);
  if (metadata.title) pdf.setTitle(metadata.title);
  if (metadata.authors.length) pdf.setAuthor(metadata.authors.join("; "));
  // Subject holds the abstract only — publication/date/DOI have their own
  // dedicated XMP fields now, so Subject is no longer an overloaded dump.
  if (metadata.abstract) pdf.setSubject(metadata.abstract);
  if (metadata.keywords.length) {
    // Copy into THIS realm's Array of strings. Zotero's getTags() returns a
    // cross-compartment array, which pdf-lib's assertIs rejects (reporting a
    // bogus "NaN" type) — the same cross-realm issue handled for the bytes above.
    pdf.setKeywords(Array.from(metadata.keywords, (k) => String(k)));
  }
  // User field mapping: Creator = first author/editor, Producer = publisher.
  if (metadata.primaryCreator) pdf.setCreator(metadata.primaryCreator);
  if (metadata.publisher) pdf.setProducer(metadata.publisher);
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
  // never leaves a corrupted original.
  await IOUtils.write(path, output, {
    tmpPath: `${path}.zpdfmanager.tmp`,
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

export async function embedMetadataForSelectedItems() {
  const pairs = new Map<number, { item: Zotero.Item; attachment: Zotero.Item }>();
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

  let success = 0;
  const failures: string[] = [];
  for (const { item, attachment } of pairs.values()) {
    try {
      if (await embedMetadataIntoAttachment(item, attachment)) success++;
      else failures.push(`${item.getDisplayTitle()}: atlandı`);
    } catch (error) {
      const reason = (error as Error)?.message || String(error);
      failures.push(`${item.getDisplayTitle()}: ${reason}`);
      ztoolkit.log("PDF metadata embedding failed", attachment.id, error);
    }
  }
  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
    .createLine({
      text: `PDF metadata: ${success} güncellendi, ${failures.length} başarısız`,
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
