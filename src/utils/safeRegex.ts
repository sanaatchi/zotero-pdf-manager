// @ajan: cursor · @etiket: katman-2, p2, safe-regex, redos
/**
 * Compile / test user-supplied regex safely on the Zotero UI thread.
 * Rejects oversized patterns, nested quantifiers, backrefs, lookaround,
 * and quantified groups that contain alternation (classic ReDoS shapes).
 */

export const MAX_USER_REGEX_PATTERN = 200;
export const MAX_USER_REGEX_TARGET = 4096;

/** Nested quantifier / classic ReDoS shape detector (heuristic, fail-closed). */
const RISKY_NESTED_QUANT =
  /(\([^)]*[+*{][^)]*\))[+*{]|([+*{]\s*){2,}|\(\?[^)]*[+*][^)]*\)[+*]/;

/** Group with `|` that is itself quantified — e.g. `(a|aa)+`, `(a|a?)*`. */
const RISKY_QUANTIFIED_ALTERNATION =
  /\((?:[^()\\]|\\.|\[(?:[^\]\\]|\\.)*\])*\|(?:[^()\\]|\\.|\[(?:[^\]\\]|\\.)*\])*\)[+*{]/;

const RISKY_BACKREF = /\\[1-9]|\\k</;
const RISKY_LOOKAROUND = /\(\?[=<!]/;

export function isRiskyUserRegexPattern(pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.length > MAX_USER_REGEX_PATTERN) return true;
  if (RISKY_BACKREF.test(pattern)) return true;
  if (RISKY_LOOKAROUND.test(pattern)) return true;
  if (RISKY_NESTED_QUANT.test(pattern)) return true;
  if (RISKY_QUANTIFIED_ALTERNATION.test(pattern)) return true;
  return false;
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
