// @ajan: cursor · @etiket: katman-2, pathutils-safe, safe-path
/**
 * PathUtils.filename / normalize / parent throw NS_ERROR_FILE_UNRECOGNIZED_PATH
 * on empty, relative, or ``attachments:…`` strings. Shared helpers for menu,
 * bidir, and disk audit — keep PathUtils off those hot paths.
 */

declare const PathUtils: any;

/** Safe basename — never throw on attachments:/relative/empty paths. */
export function safeFilename(path: string): string {
  const raw = String(path || "").trim();
  if (!raw) return "";
  const stripped = raw.replace(/^attachments:/i, "");
  try {
    // Strip Zotero linked-attachment prefix before PathUtils.
    if (/^[a-zA-Z]:[\\/]/.test(stripped) || stripped.startsWith("\\\\")) {
      return String(PathUtils.filename(stripped) || "");
    }
  } catch {
    /* fall through */
  }
  const parts = stripped.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || stripped || raw;
}

/** NFC + lowercase path key for equality / prefix checks. */
export function safePathKey(p: string): string {
  const raw = String(p || "").trim();
  if (!raw) return "";
  try {
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
      return PathUtils.normalize(raw).normalize("NFC").toLowerCase();
    }
  } catch {
    /* fall through */
  }
  return raw.normalize("NFC").toLowerCase().replace(/\\/g, "/");
}

/**
 * Case-preserving normalize for prefs / FilePicker absolute paths.
 * Falls back to trimmed raw (slash-folded) when PathUtils would throw.
 */
export function safeNormalize(path: string): string {
  const raw = String(path || "").trim();
  if (!raw) return "";
  try {
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
      return String(PathUtils.normalize(raw) || raw);
    }
  } catch {
    /* fall through */
  }
  return raw.replace(/\\/g, "/");
}

/** Safe parent dir — never throw on attachments:/relative/empty paths. */
export function safeParent(path: string): string | null {
  const raw = String(path || "").trim();
  if (!raw) return null;
  try {
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
      return PathUtils.parent?.(raw) || null;
    }
  } catch {
    /* fall through */
  }
  const norm = raw.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : null;
}
