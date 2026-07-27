import { config } from "../../package.json";

type PDFState = {
  attachment: Zotero.Item;
  exists: boolean;
  path: string;
  hash: string;
  annotations: Zotero.Item[];
  notes: Zotero.Item[];
};

function normalize(value: string) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function pdfState(attachment: Zotero.Item): Promise<PDFState> {
  let exists = false;
  try {
    exists = await attachment.fileExists();
  } catch {
    // A broken attachment is a valid merge input.
  }
  const path = exists ? String(await attachment.getFilePathAsync()) : "";
  let hash = "";
  if (exists) {
    try {
      hash = await attachment.attachmentHash;
    } catch (error) {
      ztoolkit.log("Could not hash duplicate PDF", attachment.id, error);
    }
  }
  return {
    attachment,
    exists,
    path,
    hash,
    annotations: attachment.getAnnotations(false),
    notes: attachment
      .getNotes(false)
      .map((id) => Zotero.Items.get(id))
      .filter((item): item is Zotero.Item => Boolean(item)),
  };
}

function compareProtection(a: PDFState, b: PDFState) {
  const aChildren = a.annotations.length + a.notes.length;
  const bChildren = b.annotations.length + b.notes.length;
  if (aChildren !== bChildren) return bChildren - aChildren;
  const aAdded = Date.parse(a.attachment.dateAdded || "") || 0;
  const bAdded = Date.parse(b.attachment.dateAdded || "") || 0;
  return aAdded - bAdded;
}

async function moveChildren(from: PDFState, to: PDFState) {
  for (const child of [...from.annotations, ...from.notes]) {
    (child as any).parentItemID = to.attachment.id;
    await child.saveTx();
  }
}

async function trashDuplicate(from: PDFState, to: PDFState) {
  await moveChildren(from, to);
  await Zotero.Items.trashTx(from.attachment.id);
}

async function candidateContainsAnnotations(
  protectedState: PDFState,
  candidate: PDFState,
) {
  const samples = protectedState.annotations
    .map((annotation) => normalize(annotation.annotationText || ""))
    .filter((text) => text.length >= 20)
    .slice(0, 12);
  if (!samples.length) return false;
  let text = "";
  try {
    text = normalize(
      String(await (candidate.attachment as any).attachmentText),
    );
  } catch (error) {
    ztoolkit.log(
      "Could not read candidate PDF for annotation-safe merge",
      candidate.attachment.id,
      error,
    );
  }
  if (!text) return false;
  const matched = samples.filter((sample) => {
    const excerpt = sample.slice(0, Math.min(120, sample.length));
    return text.includes(excerpt);
  }).length;
  return matched / samples.length >= 0.8;
}

async function selectedParents() {
  const parents = new Map<number, Zotero.Item>();
  for (const selected of ZoteroPane.getSelectedItems()) {
    if (selected.isRegularItem()) {
      parents.set(selected.id, selected);
    } else if (selected.isAttachment() && selected.parentItemID) {
      const parent =
        selected.parentItem || Zotero.Items.get(selected.parentItemID);
      if (parent?.isRegularItem()) parents.set(parent.id, parent);
    }
  }
  return [...parents.values()];
}

export async function mergeDuplicatePDFAttachments() {
  let merged = 0;
  let repaired = 0;
  let skipped = 0;
  let annotationsPreserved = 0;

  for (const parent of await selectedParents()) {
    const pdfs = await Promise.all(
      parent
        .getAttachments()
        .map((id) => Zotero.Items.get(id))
        .filter((item): item is Zotero.Item =>
          Boolean(
            item &&
            (item.attachmentContentType === "application/pdf" ||
              item.isPDFAttachment?.()),
          ),
        )
        .map(pdfState),
    );
    if (pdfs.length < 2) continue;

    // Exact byte-identical PDFs are always safe to consolidate. Preserve the
    // attachment with the most Zotero annotations/notes and move child data
    // from the redundant attachment before sending it to Trash.
    const byHash = new Map<string, PDFState[]>();
    for (const state of pdfs.filter((state) => state.exists && state.hash)) {
      const group = byHash.get(state.hash) || [];
      group.push(state);
      byHash.set(state.hash, group);
    }
    const trashed = new Set<number>();
    for (const group of byHash.values()) {
      if (group.length < 2) continue;
      group.sort(compareProtection);
      const keeper = group[0];
      for (const duplicate of group.slice(1)) {
        annotationsPreserved +=
          duplicate.annotations.length + duplicate.notes.length;
        await trashDuplicate(duplicate, keeper);
        trashed.add(duplicate.attachment.id);
        merged++;
      }
    }

    let remaining = pdfs.filter((state) => !trashed.has(state.attachment.id));
    let accessible = remaining.filter((state) => state.exists);

    // A broken attachment with no Zotero annotations or child notes contains
    // no user data to migrate. If its parent still has an accessible PDF, the
    // empty broken record can safely and recoverably be moved to Trash.
    if (accessible.length) {
      for (const broken of remaining.filter(
        (state) =>
          !state.exists && !state.annotations.length && !state.notes.length,
      )) {
        await Zotero.Items.trashTx(broken.attachment.id);
        trashed.add(broken.attachment.id);
        merged++;
      }
      remaining = remaining.filter(
        (state) => !trashed.has(state.attachment.id),
      );
      accessible = remaining.filter((state) => state.exists);
    }

    const brokenProtected = remaining.filter(
      (state) =>
        !state.exists &&
        state.attachment.isLinkedFileAttachment() &&
        (state.annotations.length || state.notes.length),
    );
    // A broken annotated link can be repaired only when its annotation text
    // is found in a single accessible candidate. This proves content identity
    // much more safely than comparing titles or filenames.
    if (brokenProtected.length === 1 && accessible.length === 1) {
      const keeper = brokenProtected[0];
      const candidate = accessible[0];
      if (await candidateContainsAnnotations(keeper, candidate)) {
        keeper.attachment.attachmentPath = candidate.path;
        await keeper.attachment.saveTx();
        if (await keeper.attachment.fileExists()) {
          annotationsPreserved +=
            keeper.annotations.length +
            keeper.notes.length +
            candidate.annotations.length +
            candidate.notes.length;
          await trashDuplicate(candidate, keeper);
          repaired++;
          merged++;
          continue;
        }
      }
    }

    if (remaining.length > 1) skipped++;
  }

  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 8000 })
    .createLine({
      text:
        `Safe PDF merge: ${merged} duplicate(s) moved to Trash, ` +
        `${repaired} broken annotated link(s) repaired, ` +
        `${annotationsPreserved} annotation/note item(s) preserved, ` +
        `${skipped} ambiguous record(s) skipped`,
      type: merged ? "success" : "default",
    })
    .show();

  return { merged, repaired, annotationsPreserved, skipped };
}
