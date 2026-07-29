// @ajan: cursor · @etiket: katman-2, format-metadata, normalize, isbn-checksum
/**
 * Selective helpers inspired by northword/zotero-format-metadata
 * (no-doi-prefix, pages connector, title trailing-dot, ISBN identity).
 * Behavior-adapted — not a line-for-line copy of the full linter.
 */

/** Strip URL / "DOI:" prefixes → bare `10.…` form (format-metadata no-doi-prefix). */
export function normalizeDOI(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const fromUrl = raw
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  const match = fromUrl.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
  if (match) {
    return match[0].replace(/[),.;]+$/g, "").toLowerCase();
  }
  // ShortDOI form `10/xxxx` — keep as-is for callers that resolve later.
  if (/^10\/\S+$/i.test(fromUrl)) return fromUrl.toLowerCase();
  return "";
}

export function normalizeISBNDigits(value: string): string {
  return String(value || "")
    .replace(/[^0-9Xx]/g, "")
    .toUpperCase();
}

function isbn13CheckDigit(body12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(body12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

function isbn10CheckDigit(body9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(body9[i]) * (10 - i);
  }
  const rem = (11 - (sum % 11)) % 11;
  return rem === 10 ? "X" : String(rem);
}

/** ISBN-10 with valid check digit (last may be X). */
export function isValidIsbn10(value: string): boolean {
  const d = normalizeISBNDigits(value);
  if (d.length !== 10 || !/^\d{9}[\dX]$/.test(d)) return false;
  return isbn10CheckDigit(d.slice(0, 9)) === d[9];
}

/** ISBN-13 with valid check digit. */
export function isValidIsbn13(value: string): boolean {
  const d = normalizeISBNDigits(value);
  if (d.length !== 13 || !/^\d{13}$/.test(d)) return false;
  return isbn13CheckDigit(d.slice(0, 12)) === d[12];
}

/** Convert ISBN-10 → ISBN-13 (978…) only when source checksum is valid. */
export function isbn10To13(isbn10: string): string {
  const d = normalizeISBNDigits(isbn10);
  if (!isValidIsbn10(d)) return "";
  const body = `978${d.slice(0, 9)}`;
  return body + isbn13CheckDigit(body);
}

/** Convert ISBN-13 (978…) → ISBN-10 only when source checksum is valid. */
export function isbn13To10(isbn13: string): string {
  const d = normalizeISBNDigits(isbn13);
  if (!isValidIsbn13(d) || !d.startsWith("978")) return "";
  const body9 = d.slice(3, 12);
  return body9 + isbn10CheckDigit(body9);
}

/** True when two valid ISBN strings refer to the same work (10↔13 aware). */
export function isbnsEquivalent(a: string, b: string): boolean {
  const left = normalizeISBNDigits(a);
  const right = normalizeISBNDigits(b);
  if (!left || !right) return false;
  const leftOk = isValidIsbn10(left) || isValidIsbn13(left);
  const rightOk = isValidIsbn10(right) || isValidIsbn13(right);
  if (!leftOk || !rightOk) return false;
  if (left === right) return true;
  if (left.length === 10 && right.length === 13) {
    return isbn10To13(left) === right;
  }
  if (left.length === 13 && right.length === 10) {
    return isbn10To13(right) === left;
  }
  if (left.length === 10 && right.length === 10) {
    const a13 = isbn10To13(left);
    const b13 = isbn10To13(right);
    return !!a13 && a13 === b13;
  }
  return false;
}

/** format-metadata correct-pages-connector */
export function normalizePagesConnector(pages: string): string {
  return String(pages || "")
    .replace(/~/g, "-")
    .replace(/\+/g, ", ");
}

/** format-metadata no-title-trailing-dot */
export function stripTitleTrailingDot(title: string): string {
  return String(title || "").replace(/(.*)\.$/g, "$1");
}
