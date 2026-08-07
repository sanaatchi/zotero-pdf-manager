// @ajan: cursor · @etiket: katman-2, validated-pdf-lock, match-claim
/**
 * After a PDF is attached and content-validated for a parent item, keep that
 * disk path from being auto-matched / reconciled onto a different parent.
 *
 * Enforcement is path-based (normalized). Live attachment scan is the hard
 * gate; Extra `ZPDF-Validated-Path:` is the durable “validated” stamp so
 * audits and rematch logic can tell a confirmed bind from a mere link.
 */

declare const PathUtils: any;

export const VALIDATED_PATH_PREFIX = "ZPDF-Validated-Path:";

export type PdfPathClaim = {
  parentID: number;
  parentKey: string;
  attachmentID: number;
  path: string;
  validated: boolean;
};

function clearExtraPrefixedLine(extra: string, prefix: string): string {
  const cleanPrefix = String(prefix || "").trim();
  if (!cleanPrefix) return String(extra || "");
  return String(extra || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !l.trim().startsWith(cleanPrefix))
    .join("\n");
}

/** NFC + lowercase + PathUtils.normalize when available. */
export function normalizeClaimPath(path: string): string {
  const raw = String(path || "").trim();
  if (!raw) return "";
  let normalized = raw;
  try {
    if (typeof PathUtils?.normalize === "function") {
      normalized = PathUtils.normalize(raw);
    }
  } catch {
    normalized = raw;
  }
  try {
    normalized = normalized.normalize("NFC");
  } catch {
    /* ignore */
  }
  return normalized.replace(/\//g, "\\").toLowerCase();
}

export function listValidatedPathsFromExtra(extra: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of String(extra || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed.toLowerCase().startsWith(VALIDATED_PATH_PREFIX.toLowerCase())
    ) {
      continue;
    }
    const value = trimmed.slice(VALIDATED_PATH_PREFIX.length).trim();
    const key = normalizeClaimPath(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Replace all validated-path Extra lines with the given set (normalized unique). */
export function rewriteValidatedPathExtra(
  extra: string,
  paths: string[],
): string {
  const base = clearExtraPrefixedLine(extra, VALIDATED_PATH_PREFIX);
  const lines = String(base || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const keys = new Set<string>();
  for (const path of paths) {
    const display = String(path || "")
      .trim()
      .slice(0, 500);
    const key = normalizeClaimPath(display);
    if (!key || keys.has(key)) continue;
    keys.add(key);
    lines.push(`${VALIDATED_PATH_PREFIX} ${display}`);
  }
  return lines.join("\n");
}

export function addValidatedPathToExtra(extra: string, path: string): string {
  const existing = listValidatedPathsFromExtra(extra);
  const key = normalizeClaimPath(path);
  if (!key) return String(extra || "");
  if (existing.some((p) => normalizeClaimPath(p) === key)) {
    return rewriteValidatedPathExtra(extra, existing);
  }
  return rewriteValidatedPathExtra(extra, [...existing, path]);
}

export function removeValidatedPathFromExtra(
  extra: string,
  path: string,
): string {
  const key = normalizeClaimPath(path);
  const kept = listValidatedPathsFromExtra(extra).filter(
    (p) => normalizeClaimPath(p) !== key,
  );
  return rewriteValidatedPathExtra(extra, kept);
}

export function clearAllValidatedPathsFromExtra(extra: string): string {
  return clearExtraPrefixedLine(extra, VALIDATED_PATH_PREFIX);
}

export function isPathClaimedByOther(
  path: string,
  parentID: number,
  claims: Map<string, PdfPathClaim>,
): boolean {
  const key = normalizeClaimPath(path);
  if (!key) return false;
  const claim = claims.get(key);
  if (!claim) return false;
  return claim.parentID !== parentID;
}

/**
 * Scan library PDF attachments and build path → parent claims.
 * Any live attachment path is claimed (blocks double-link). `validated` is
 * true when the parent Extra lists that path under ZPDF-Validated-Path.
 */
export async function collectAttachedPdfPathClaims(opts?: {
  excludeParentID?: number;
}): Promise<Map<string, PdfPathClaim>> {
  const claims = new Map<string, PdfPathClaim>();
  const excludeParentID = opts?.excludeParentID;
  try {
    const attachmentTypeID = Zotero.ItemTypes.getID("attachment");
    const rows =
      (await Zotero.DB.queryAsync(
        `SELECT itemID FROM items WHERE itemTypeID=${attachmentTypeID} ` +
          `AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
      )) || [];
    for (const row of rows) {
      const attachment = await Zotero.Items.getAsync(row.itemID);
      if (!attachment?.isFileAttachment?.()) continue;
      const isPdf =
        Boolean(attachment.isPDFAttachment?.()) ||
        String(attachment.attachmentContentType || "").toLowerCase() ===
          "application/pdf";
      if (!isPdf) continue;
      const parentID = Number(attachment.parentItemID || 0);
      if (!parentID) continue;
      if (excludeParentID && parentID === excludeParentID) continue;
      let path = "";
      try {
        path = String((await attachment.getFilePathAsync?.()) || "");
      } catch {
        path = "";
      }
      if (!path) continue;
      const key = normalizeClaimPath(path);
      if (!key || claims.has(key)) continue;

      let parentKey = "";
      let validated = false;
      try {
        const parent = await Zotero.Items.getAsync(parentID);
        parentKey = String(parent?.key || "");
        const extra = String(parent?.getField?.("extra") || "");
        const validatedPaths =
          listValidatedPathsFromExtra(extra).map(normalizeClaimPath);
        validated = validatedPaths.includes(key);
      } catch {
        /* best-effort */
      }

      claims.set(key, {
        parentID,
        parentKey,
        attachmentID: attachment.id,
        path,
        validated,
      });
    }
  } catch (e) {
    try {
      ztoolkit.log("collectAttachedPdfPathClaims failed", e);
    } catch {
      /* tests */
    }
  }
  return claims;
}

/** Persist validated path on parent Extra after content match. */
export async function persistValidatedPdfLock(
  parent: Zotero.Item,
  attachment: Zotero.Item,
): Promise<string> {
  let path = "";
  try {
    path = String((await attachment.getFilePathAsync?.()) || "");
  } catch {
    path = "";
  }
  if (!path) return "";
  try {
    if (typeof (parent as any)?.getField !== "function") return path;
    const prev = String(parent.getField("extra") || "");
    const next = addValidatedPathToExtra(prev, path);
    if (next !== prev) {
      parent.setField("extra", next);
      await parent.saveTx();
    }
  } catch (e) {
    try {
      ztoolkit.log("persistValidatedPdfLock failed", e);
    } catch {
      /* tests */
    }
  }
  return path;
}

/** Drop validated Extra stamp(s) — e.g. after mismatch re-tag or unlink. */
export async function clearValidatedPdfLock(
  parent: Zotero.Item,
  path?: string,
): Promise<void> {
  try {
    if (typeof (parent as any)?.getField !== "function") return;
    const prev = String(parent.getField("extra") || "");
    const next = path
      ? removeValidatedPathFromExtra(prev, path)
      : clearAllValidatedPathsFromExtra(prev);
    if (next === prev) return;
    parent.setField("extra", next);
    await parent.saveTx();
  } catch (e) {
    try {
      ztoolkit.log("clearValidatedPdfLock failed", e);
    } catch {
      /* tests */
    }
  }
}

/**
 * After content match: stamp Extra. Call from validate/audit/finalize paths.
 */
export async function lockValidatedAttachment(
  parent: Zotero.Item,
  attachmentID: number,
): Promise<void> {
  try {
    const attachment = await Zotero.Items.getAsync(attachmentID);
    if (!attachment?.isFileAttachment?.()) return;
    await persistValidatedPdfLock(parent, attachment);
  } catch (e) {
    try {
      ztoolkit.log("lockValidatedAttachment failed", e);
    } catch {
      /* tests */
    }
  }
}
