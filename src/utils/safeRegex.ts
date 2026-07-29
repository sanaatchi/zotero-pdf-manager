// @ajan: cursor · @etiket: katman-2, p2, safe-regex, redos
/**
 * Compile / test user-supplied regex safely on the Zotero UI thread.
 * Rejects oversized patterns, nested quantifier shapes, and caps match targets.
 */

export const MAX_USER_REGEX_PATTERN = 200;
export const MAX_USER_REGEX_TARGET = 4096;

/** Rough nested-quantifier / classic ReDoS shape detector (not a full analyzer). */
const RISKY_NESTED_QUANT =
  /(\([^)]*[+*{][^)]*\))[+*{]|([+*{]\s*){2,}|\(\?[^)]*[+*][^)]*\)[+*]/;

export function isRiskyUserRegexPattern(pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.length > MAX_USER_REGEX_PATTERN) return true;
  return RISKY_NESTED_QUANT.test(pattern);
}

export function compileUserRegex(pattern: string, flags = ""): RegExp | null {
  const trimmed = (pattern || "").trim();
  if (!trimmed) return null;
  if (isRiskyUserRegexPattern(trimmed)) return null;
  try {
    return new RegExp(trimmed, flags);
  } catch {
    return null;
  }
}

export function safeRegexTest(re: RegExp, target: string): boolean {
  const text =
    target.length > MAX_USER_REGEX_TARGET
      ? target.slice(0, MAX_USER_REGEX_TARGET)
      : target;
  return re.test(text);
}
