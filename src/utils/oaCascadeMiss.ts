// @ajan: cursor · @etiket: katman-2, oa-cascade-miss, search-log
/**
 * Pure helpers for download-report / auto-cascade miss messages + log body.
 * No Zotero globals — unit-tested. Policy text stays here (TR article / thesis).
 */

export type CascadeAttemptLike = {
  source: string;
  outcome?: string;
  reason?: string;
};

export type CascadeMissHints = {
  isTurkishJournal: boolean;
  isBook: boolean;
  isThesis: boolean;
};

export function cascadeMissMessage(
  hints: CascadeMissHints,
  attempts: CascadeAttemptLike[],
): string | undefined {
  const tried = new Set(attempts.map((a) => a.source));
  if (hints.isTurkishJournal) {
    if (!tried.has("dergipark")) {
      return (
        "Türkçe makale: yalnızca DergiPark (+ DOI varsa Unpaywall) denenir. " +
        "Tercihler → PDF Manager → DergiPark’ı açın."
      );
    }
    return tried.has("doi")
      ? "Türkçe makale: DergiPark ve Unpaywall’da bulunamadı (başka kaynak aranmaz)."
      : "Türkçe makale: DergiPark’ta bulunamadı (DOI yok, Unpaywall denenmedi; başka kaynak aranmaz).";
  }
  if (hints.isBook && !tried.has("libgen")) {
    return (
      "Kitap: LibGen denenmedi. Tercihler → PDF Manager → LibGen’i açın " +
      "(veya eklentiyi yeniden yükleyin; LibGen varsayılan açılır)."
    );
  }
  if (hints.isThesis && !tried.has("yoktez")) {
    return (
      "Tez: yalnızca YÖKTez denenir. " +
      "Tercihler → PDF Manager → YÖKTez’i açın."
    );
  }
  if (hints.isThesis) {
    const yok = attempts.find((a) => a.source === "yoktez" && a.reason);
    if (yok?.reason) return yok.reason;
    return "Tez: YÖKTez’te bulunamadı (başka kaynak aranmaz).";
  }
  return undefined;
}

export function cascadeMissKind(
  hints: CascadeMissHints,
  attempts: CascadeAttemptLike[],
): string {
  if (hints.isTurkishJournal) {
    if (!attempts.some((a) => a.source === "dergipark")) {
      return "tr-article-disabled";
    }
    return "tr-article-miss";
  }
  if (hints.isThesis) {
    if (!attempts.some((a) => a.source === "yoktez")) return "thesis-disabled";
    return "thesis-miss";
  }
  if (hints.isBook && !attempts.some((a) => a.source === "libgen")) {
    return "book-libgen-skipped";
  }
  if (attempts.some((a) => a.outcome === "rejected")) return "content-mismatch";
  if (attempts.some((a) => a.outcome === "error")) return "cascade-error";
  return "cascade-miss";
}

export function fallbackCascadeMessage(attempts: CascadeAttemptLike[]): string {
  const bits = attempts
    .filter((a) => a.outcome !== "unsupported")
    .map(
      (a) =>
        `${a.source}:${a.outcome || "no-match"}${
          a.reason ? `(${a.reason})` : ""
        }`,
    );
  return bits.length
    ? `PDF bulunamadı — ${bits.join(" · ")}`
    : "PDF bulunamadı";
}

export function buildOaCascadeLogBody(opts: {
  kind: string;
  message: string;
  origin: string;
  title?: string;
  doi?: string;
  isbn?: string;
  authors?: string;
  year?: string;
  language?: string;
  itemType?: string;
  attempts?: CascadeAttemptLike[];
}): Record<string, unknown> {
  const attempts = (opts.attempts || []).slice(0, 20).map((a) => ({
    source: a.source,
    outcome: a.outcome || "",
    ...(a.reason ? { reason: a.reason } : {}),
  }));
  return {
    kind: opts.kind,
    message: opts.message,
    origin: opts.origin,
    text: opts.title || "",
    doi: opts.doi || "",
    isbn: opts.isbn || "",
    authors: opts.authors || "",
    year: opts.year || "",
    language: opts.language || "",
    itemType: opts.itemType || "",
    sourcesTried: attempts.map((a) => a.source).filter(Boolean),
    attempts,
  };
}
