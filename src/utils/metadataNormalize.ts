// @ajan: cursor · @etiket: katman-2, format-metadata, normalize, b4-lint, pages-range, creators-case
/**
 * Selective helpers inspired by northword/zotero-format-metadata
 * (no-doi-prefix, pages connector/range, title trailing-dot, ISBN identity,
 * thesis type, leading zeros, language guess, creators-case, extra order).
 * Behavior-adapted — not a line-for-line copy of the full linter.
 * Journal abbreviation: intentionally skipped (low TR archive value).
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

/** format-metadata no-*-extra-zeros (pages/issue/volume). */
export function removeLeadingZeros(input: string): string {
  return String(input || "")
    .replace(/\b0+(\d+)/g, "$1")
    .replace("0-", "1-");
}

/**
 * format-metadata correct-thesis-type (TR + EN common labels).
 * Returns null when unchanged / empty.
 */
export function normalizeThesisType(raw: string): string | null {
  const type = String(raw || "").trim();
  if (!type) return null;
  let next = type;
  if (/硕士/.test(type)) next = "硕士学位论文";
  else if (/博士/.test(type) && !/硕士/.test(type)) next = "博士学位论文";
  else if (/ph\.?\s*d\.?/i.test(type) || /doctor/i.test(type)) {
    next = "Doctoral dissertation";
  } else if (/master/i.test(type)) next = "Master thesis";
  else if (/yüksek\s*lisans/i.test(type)) next = "Yüksek Lisans Tezi";
  else if (/doktora/i.test(type)) next = "Doktora Tezi";
  return next === type ? null : next;
}

/**
 * Lightweight language guess for titles (no tinyld).
 * Priority: CJK → zh-CN · Turkish letters → tr-TR · Latin → en-US.
 */
export function guessLanguageTag(title: string): string | null {
  const t = String(title || "").trim();
  if (!t) return null;
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh-CN";
  if (/[ğüşıöçĞÜŞİÖÇ]/.test(t)) return "tr-TR";
  if (/[A-Za-zÀ-ÿ]{3,}/.test(t)) return "en-US";
  return null;
}

export type FieldNormalizePatch = {
  field: string;
  from: string;
  to: string;
};

/**
 * Plan field patches for one item snapshot (pure).
 * Does not invent DOI/ISBN — only cleans present values.
 */
export function planFieldNormalizations(opts: {
  title?: string;
  language?: string;
  pages?: string;
  issue?: string;
  volume?: string;
  doi?: string;
  thesisType?: string;
  itemType?: string;
}): FieldNormalizePatch[] {
  const patches: FieldNormalizePatch[] = [];
  const push = (field: string, from: string, to: string) => {
    if (to && to !== from) patches.push({ field, from, to });
  };

  if (opts.title != null) {
    const cleaned = stripTitleTrailingDot(opts.title);
    push("title", opts.title, cleaned);
  }
  if (opts.doi != null && opts.doi.trim()) {
    const cleaned = normalizeDOI(opts.doi);
    if (cleaned) push("DOI", opts.doi, cleaned);
  }
  if (opts.pages != null && opts.pages.trim()) {
    const pages = normalizePagesRangeOrder(opts.pages);
    push("pages", opts.pages, pages);
  }
  if (opts.issue != null && opts.issue.trim()) {
    push("issue", opts.issue, removeLeadingZeros(opts.issue));
  }
  if (opts.volume != null && opts.volume.trim()) {
    push("volume", opts.volume, removeLeadingZeros(opts.volume));
  }
  if (opts.itemType === "thesis" && opts.thesisType != null) {
    const next = normalizeThesisType(opts.thesisType);
    if (next) push("thesisType", opts.thesisType, next);
  }
  const lang = String(opts.language || "").trim();
  if (!lang && opts.title) {
    const guessed = guessLanguageTag(opts.title);
    if (guessed) push("language", lang, guessed);
  }
  return patches;
}

/** True when pages field looks like a single start page suitable for PDF-length expansion. */
export function shouldExpandPagesFromPdf(pages: string): boolean {
  const p = String(pages || "").trim();
  if (!p) return false;
  if (
    p.includes("-") ||
    p.includes(",") ||
    p.includes("–") ||
    p.includes("—")
  ) {
    return false;
  }
  if (p.length > 3) return false;
  if (Number.isNaN(Number(p))) return false;
  return true;
}

/** first page + PDF page count → "first-(first+total-1)". */
export function generatePagesRange(first: string, totalPages: number): string {
  if (!(totalPages > 0)) return String(first || "").trim();
  if (Number(first)) {
    const start = Number(first);
    return `${start}-${start + totalPages - 1}`;
  }
  return `1-${totalPages}`;
}

/** Swap inverted numeric ranges: "34-12" → "12-34"; unify en/em dash to "-". */
export function normalizePagesRangeOrder(pages: string): string {
  let p = String(pages || "")
    .trim()
    .replace(/[–—]/g, "-");
  p = normalizePagesConnector(p);
  p = removeLeadingZeros(p);
  const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return p;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > b) return `${b}-${a}`;
  return `${a}-${b}`;
}

export function isFullUpperCase(text: string): boolean {
  const t = String(text || "");
  return t.length > 0 && t === t.toUpperCase();
}

export function isFullLowerCase(text: string): boolean {
  const t = String(text || "");
  return t.length > 0 && t === t.toLowerCase() && /[a-zà-ÿ]/i.test(t);
}

/** Title-case a name part (simple capitalizeName stand-in). */
export function capitalizeNamePart(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return s;
  return s
    .split(/(\s+|-)/)
    .map((chunk) => {
      if (!chunk || /^\s+$/.test(chunk) || chunk === "-") return chunk;
      return chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase();
    })
    .join("");
}

export type CreatorNameParts = {
  fieldMode: number;
  firstName?: string;
  lastName?: string;
};

/** format-metadata correct-creators-case (pure). */
export function normalizeCreatorCase(
  creators: CreatorNameParts[],
): CreatorNameParts[] {
  return creators.map((c) => {
    if (c.fieldMode === 0) {
      const first = c.firstName || "";
      const last = c.lastName || "";
      return {
        ...c,
        firstName:
          isFullUpperCase(first) || isFullLowerCase(first)
            ? capitalizeNamePart(first)
            : first,
        lastName:
          isFullUpperCase(last) || isFullLowerCase(last)
            ? capitalizeNamePart(last)
            : last,
      };
    }
    const last = c.lastName || "";
    return {
      ...c,
      lastName: isFullUpperCase(last) ? last : capitalizeNamePart(last),
    };
  });
}

export type ExtraLine =
  { kind: "kv"; key: string; value: string } | { kind: "raw"; text: string };

export function parseExtraLines(extra: string): ExtraLine[] {
  const lines = String(extra || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const out: ExtraLine[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) out.push({ kind: "kv", key: m[1].trim(), value: m[2] });
    else out.push({ kind: "raw", text: line });
  }
  return out;
}

export function serializeExtraLines(lines: ExtraLine[]): string {
  return lines
    .map((l) => (l.kind === "kv" ? `${l.key}: ${l.value}` : l.text))
    .join("\n");
}

/**
 * B4c: Citation Key first, then Kutuphane-* keys, then other kv A–Z, raw last.
 */
export function sortExtraLines(lines: ExtraLine[]): ExtraLine[] {
  const kv = lines.filter(
    (l): l is Extract<ExtraLine, { kind: "kv" }> => l.kind === "kv",
  );
  const raw = lines.filter((l) => l.kind === "raw");
  const collator = new Intl.Collator("en", { sensitivity: "base" });
  const rank = (key: string): number => {
    const a = key.toLowerCase();
    if (a === "citation key" || a === "citation-key") return 0;
    if (a.startsWith("kutuphane-") || a.startsWith("kutuphane ")) return 1;
    return 2;
  };
  kv.sort((x, y) => {
    const rx = rank(x.key);
    const ry = rank(y.key);
    if (rx !== ry) return rx - ry;
    return collator.compare(x.key, y.key);
  });
  return [...kv, ...raw];
}

export function reorderExtraField(extra: string): string | null {
  const lines = parseExtraLines(extra);
  if (!lines.length) return null;
  const sorted = sortExtraLines(lines);
  const next = serializeExtraLines(sorted);
  const prev = serializeExtraLines(lines);
  return next === prev ? null : next;
}
