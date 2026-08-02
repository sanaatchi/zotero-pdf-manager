// @ajan: cursor · @etiket: katman-2, b5-dup-report, item-duplicate, kp-align
/**
 * Thin duplicate-item candidate report (DOI / ISBN / KP).
 * No merges — zoplicate remains the companion XPI for master merge.
 */

import {
  normalizeDOI,
  normalizeISBNDigits,
  isbnsEquivalent,
} from "./metadataNormalize";
import { extractKpFromText } from "./kpToken";

export type DupItemSnap = {
  itemId: number;
  title: string;
  doi?: string;
  isbn?: string;
  kp?: string;
};

export type DupGroup = {
  key: string;
  kind: "doi" | "isbn" | "kp";
  itemIds: number[];
  titles: string[];
};

/** @deprecated Prefer extractKpFromText from kpToken — kept for callers. */
export function extractKpToken(text: string | null | undefined): string | null {
  return extractKpFromText(text);
}

export function findDuplicateGroups(items: DupItemSnap[]): DupGroup[] {
  const byDoi = new Map<string, DupItemSnap[]>();
  const byIsbn = new Map<string, DupItemSnap[]>();
  const byKp = new Map<string, DupItemSnap[]>();

  for (const it of items) {
    const doi = normalizeDOI(it.doi || "");
    if (doi) {
      const list = byDoi.get(doi) || [];
      list.push(it);
      byDoi.set(doi, list);
    }
    const isbn = normalizeISBNDigits(it.isbn || "");
    if (isbn && (isbn.length === 10 || isbn.length === 13)) {
      const list = byIsbn.get(isbn) || [];
      list.push(it);
      byIsbn.set(isbn, list);
    }
    const kp = it.kp || extractKpToken(it.title);
    if (kp) {
      const list = byKp.get(kp) || [];
      list.push(it);
      byKp.set(kp, list);
    }
  }

  const groups: DupGroup[] = [];
  for (const [key, list] of byDoi) {
    if (list.length < 2) continue;
    groups.push({
      key,
      kind: "doi",
      itemIds: list.map((x) => x.itemId),
      titles: list.map((x) => x.title),
    });
  }

  // ISBN: merge equivalent 10↔13 into one group
  const isbnSeen = new Set<number>();
  const isbnKeys = [...byIsbn.keys()];
  for (let i = 0; i < isbnKeys.length; i++) {
    const key = isbnKeys[i];
    const seed = byIsbn.get(key) || [];
    if (seed.some((x) => isbnSeen.has(x.itemId))) continue;
    const cluster = [...seed];
    for (let j = i + 1; j < isbnKeys.length; j++) {
      const other = isbnKeys[j];
      if (isbnsEquivalent(key, other)) {
        cluster.push(...(byIsbn.get(other) || []));
      }
    }
    const uniq = new Map<number, DupItemSnap>();
    for (const it of cluster) uniq.set(it.itemId, it);
    if (uniq.size < 2) continue;
    for (const id of uniq.keys()) isbnSeen.add(id);
    const arr = [...uniq.values()];
    groups.push({
      key,
      kind: "isbn",
      itemIds: arr.map((x) => x.itemId),
      titles: arr.map((x) => x.title),
    });
  }

  for (const [key, list] of byKp) {
    if (list.length < 2) continue;
    groups.push({
      key,
      kind: "kp",
      itemIds: list.map((x) => x.itemId),
      titles: list.map((x) => x.title),
    });
  }

  groups.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key),
  );
  return groups;
}

export function formatDuplicateReportLines(
  groups: DupGroup[],
  options?: { maxGroups?: number },
): string[] {
  const maxGroups = options?.maxGroups ?? 20;
  if (!groups.length) {
    return ["duplicate candidates: none (DOI / ISBN / KP)"];
  }
  const lines = [
    `duplicate candidates: ${groups.length} group(s) — no writes (use Zoplicate to merge)`,
  ];
  for (const g of groups.slice(0, maxGroups)) {
    lines.push(`${g.kind.toUpperCase()} ${g.key} · ${g.itemIds.length} items`);
    for (let i = 0; i < Math.min(g.titles.length, 4); i++) {
      lines.push(`  #${g.itemIds[i]} ${g.titles[i].slice(0, 80)}`);
    }
    if (g.titles.length > 4) {
      lines.push(`  …and ${g.titles.length - 4} more`);
    }
  }
  if (groups.length > maxGroups) {
    lines.push(`…and ${groups.length - maxGroups} more groups`);
  }
  return lines;
}
