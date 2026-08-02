// @ajan: cursor · @etiket: katman-2, b1-delete-att, delitemwithatt, plan
/**
 * Pure attachment-delete planning (delitemwithatt behavior, selective).
 * No Zotero globals — unit-testable.
 */

/** Zotero.Attachments.LINK_MODE_LINKED_FILE */
export const LINK_MODE_LINKED_FILE = 3;

export type AttachmentDeleteRow = {
  attachmentId: number;
  parentItemId: number | null;
  linkMode: number;
  path: string | null;
  contentType: string;
};

export type AttachmentDeletePlan = {
  trashAttachmentIds: number[];
  unlinkPaths: string[];
  linkedFileCount: number;
  otherAttachmentCount: number;
};

export {
  isPdfOrAnyAttachment,
  planAttachmentDeletion,
  formatDeleteConfirmLines,
};

function isPdfOrAnyAttachment(
  contentType: string,
  opts?: { pdfOnly?: boolean },
): boolean {
  if (!opts?.pdfOnly) return true;
  return String(contentType || "").toLowerCase() === "application/pdf";
}

/**
 * Plan Zotero trash + optional disk unlink for LINKED_FILE attachments.
 * Imported/stored files: trash only (Zotero storage owns the bytes).
 */
function planAttachmentDeletion(
  rows: AttachmentDeleteRow[],
  opts: { deleteLinkedFiles: boolean; pdfOnly?: boolean },
): AttachmentDeletePlan {
  const trashAttachmentIds: number[] = [];
  const unlinkPaths: string[] = [];
  let linkedFileCount = 0;
  let otherAttachmentCount = 0;
  const seenTrash = new Set<number>();
  const seenPath = new Set<string>();

  for (const row of rows) {
    if (!isPdfOrAnyAttachment(row.contentType, { pdfOnly: opts.pdfOnly })) {
      continue;
    }
    if (!seenTrash.has(row.attachmentId)) {
      seenTrash.add(row.attachmentId);
      trashAttachmentIds.push(row.attachmentId);
    }
    const linked = row.linkMode === LINK_MODE_LINKED_FILE;
    if (linked) {
      linkedFileCount += 1;
      if (opts.deleteLinkedFiles && row.path) {
        const key = row.path.replace(/\\/g, "/").toLowerCase();
        if (!seenPath.has(key)) {
          seenPath.add(key);
          unlinkPaths.push(row.path);
        }
      }
    } else {
      otherAttachmentCount += 1;
    }
  }

  return {
    trashAttachmentIds,
    unlinkPaths,
    linkedFileCount,
    otherAttachmentCount,
  };
}

function formatDeleteConfirmLines(
  plan: AttachmentDeletePlan,
  opts: { deleteLinkedFiles: boolean; maxPaths?: number },
): string[] {
  const maxPaths = opts.maxPaths ?? 8;
  const lines = [
    `attachments to trash: ${plan.trashAttachmentIds.length}`,
    `linked files: ${plan.linkedFileCount}`,
    `stored/imported: ${plan.otherAttachmentCount}`,
  ];
  if (opts.deleteLinkedFiles) {
    lines.push(
      `disk files to delete (not recoverable): ${plan.unlinkPaths.length}`,
    );
    for (const p of plan.unlinkPaths.slice(0, maxPaths)) {
      lines.push(`  ${p}`);
    }
    if (plan.unlinkPaths.length > maxPaths) {
      lines.push(`  …and ${plan.unlinkPaths.length - maxPaths} more`);
    }
  } else {
    lines.push("disk linked files will be kept");
  }
  return lines;
}
