// @ajan: cursor · @etiket: katman-2, p2-3, p2-5, p2-6, reconciler, notifier, orphan, audit
import { getPref } from "../utils/prefs";
import {
  buildIndex,
  getLastIndexBuildMeta,
  isFolderIndexComplete,
} from "./folderIndex";
import { LocalFolderSource } from "./pdfSources";
import { tryAutomaticOnlineSources } from "./pdfDownload";
import { processOrphanPDFs, normalizeOrphanMode } from "./orphanProcessor";
import { appendAuditEvent, openAutomationAuditReport } from "./automationAudit";

export interface ReconcileStats {
  scanned: number;
  attached: number;
  review: number;
  skipped: number;
  errors: number;
  created: number;
  planned: number;
}

export function normalizePeriodicMinutes(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(`${value ?? ""}`, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 30;
  return Math.min(Math.floor(parsed), 10080);
}

/** Attanger-style settle delay for add-notifier coalescing (P2-2/P2-3). */
export function normalizeAddSettleMs(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(`${value ?? ""}`, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1000;
  return Math.min(Math.floor(parsed), 60000);
}

export function canReconcileItem(item: Zotero.Item): boolean {
  try {
    if (!item?.isRegularItem() || (item as any).isFeedItem || item.deleted) {
      return false;
    }
    return !item.getAttachments().some((id: number) => {
      const attachment = Zotero.Items.get(id);
      return attachment?.attachmentContentType === "application/pdf";
    });
  } catch {
    return false;
  }
}

/**
 * Map notifier add IDs to top-level regular items (P2-3).
 * Connector often fires separate `add` events for parent + attachments —
 * attachment IDs resolve to their parent so one settle flush covers the row.
 */
export function expandAddedItemIDs(
  ids: Iterable<number>,
  getItem: (id: number) => Zotero.Item | false | undefined | null,
): number[] {
  const out = new Set<number>();
  for (const id of ids) {
    if (!Number.isFinite(id)) continue;
    let item: Zotero.Item | false | undefined | null;
    try {
      item = getItem(id);
    } catch {
      continue;
    }
    if (!item) continue;
    try {
      if ((item as any).deleted) continue;
      if (
        typeof item.isRegularItem === "function" &&
        item.isRegularItem() &&
        (!(item as any).isTopLevelItem || (item as any).isTopLevelItem())
      ) {
        out.add(item.id);
        continue;
      }
      if (typeof item.isAttachment === "function" && item.isAttachment()) {
        const parentID = Number((item as any).parentItemID);
        if (!Number.isFinite(parentID) || parentID <= 0) continue;
        const parent = getItem(parentID);
        if (
          parent &&
          !(parent as any).deleted &&
          typeof parent.isRegularItem === "function" &&
          parent.isRegularItem()
        ) {
          out.add(parent.id);
        }
      }
    } catch {
      /* skip malformed items */
    }
  }
  return Array.from(out);
}

async function addAutomationTag(item: Zotero.Item, tag: string) {
  try {
    const tags = (item.getTags() as { tag: string }[]) || [];
    if (tags.some((entry) => entry.tag === tag)) return;
    item.addTag(tag);
    await item.saveTx();
  } catch (e) {
    ztoolkit.log(`Could not add automation tag ${tag}`, e);
  }
}

/**
 * Startup/periodic local-folder reconciliation.
 *
 * Runs are coalesced: if a timer fires while reconciliation is active it gets
 * the existing promise instead of starting a second library scan.
 * Add-notifier flushes drain pending IDs in a while-loop (Attanger P2-3).
 */
export class PDFReconciler {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private addTimer: ReturnType<typeof setTimeout> | null = null;
  private activeRun: Promise<ReconcileStats> | null = null;
  private addFlushRunning = false;
  private notifierID = "";
  private pendingItemIDs = new Set<number>();
  private disposed = false;

  start() {
    this.disposeTimers();
    this.disposed = false;

    if (getPref("pdf.autoOnStartup") !== false) {
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        void this.run("startup");
      }, 5000);
    }

    const minutes = normalizePeriodicMinutes(
      getPref("pdf.periodicMinutes") ?? 30,
    );
    if (minutes > 0) {
      this.periodicTimer = setInterval(
        () => void this.run("periodic"),
        minutes * 60 * 1000,
      );
    }

    // Re-bind notifier every start so toggling autoOnAdd actually sticks.
    this.unregisterNotifier();
    if (getPref("pdf.autoOnAdd") !== false) {
      this.registerNotifier();
    }
  }

  run(reason: "startup" | "periodic" | "manual" = "manual") {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.performRun(reason).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  async processOrphansNow() {
    if (this.activeRun) await this.activeRun;
    if (this.disposed) return null;
    const runID = `manual-orphans-${Date.now()}`;
    const libraryID = (Zotero.Libraries as any).userLibraryID;
    const [index, items] = await Promise.all([
      buildIndex(true),
      (Zotero.Items as any).getAll(libraryID, true, false) as Promise<
        Zotero.Item[]
      >,
    ]);
    return processOrphanPDFs(
      index,
      items,
      libraryID,
      "autoCreate",
      Number(getPref("pdf.orphanMaxPerRun") ?? 10),
      getPref("pdf.dryRun") === true,
      runID,
      "manual",
    );
  }

  dispose() {
    this.disposed = true;
    this.disposeTimers();
    this.pendingItemIDs.clear();
    this.unregisterNotifier();
  }

  private disposeTimers() {
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    if (this.periodicTimer !== null) clearInterval(this.periodicTimer);
    if (this.addTimer !== null) clearTimeout(this.addTimer);
    this.startupTimer = null;
    this.periodicTimer = null;
    this.addTimer = null;
  }

  private unregisterNotifier() {
    if (!this.notifierID) return;
    try {
      Zotero.Notifier.unregisterObserver(this.notifierID);
    } catch (e) {
      ztoolkit.log("Could not unregister PDF reconciler notifier", e);
    }
    this.notifierID = "";
  }

  private registerNotifier() {
    if (this.notifierID) return;
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: (string | number)[]) => {
          if (this.disposed || type !== "item") return;
          if (event === "add") {
            this.queueAddedItems(ids);
            return;
          }
          if (event === "trash" || event === "delete") {
            this.cancelPendingItems(ids);
          }
        },
      },
      ["item"],
      "zotero-pdf-manager-auto-reconcile",
    );
  }

  private queueAddedItems(ids: (string | number)[]) {
    for (const id of ids) {
      const numericID = Number(id);
      if (Number.isFinite(numericID)) this.pendingItemIDs.add(numericID);
    }
    this.scheduleAddedItems();
  }

  private cancelPendingItems(ids: (string | number)[]) {
    let removed = false;
    for (const id of ids) {
      const numericID = Number(id);
      if (!Number.isFinite(numericID)) continue;
      if (this.pendingItemIDs.delete(numericID)) removed = true;
      // Parent deleted → drop any pending attachment IDs for that parent later
      // via expand; also drop the parent itself if queued.
    }
    if (removed && this.pendingItemIDs.size === 0 && this.addTimer !== null) {
      clearTimeout(this.addTimer);
      this.addTimer = null;
    }
  }

  private scheduleAddedItems() {
    // A flush already running will drain new IDs in its while-loop / finally.
    if (this.addFlushRunning) return;
    if (this.addTimer !== null) clearTimeout(this.addTimer);
    let settleMs = 1000;
    try {
      settleMs = normalizeAddSettleMs(getPref("pdf.addSettleMs") ?? 1000);
    } catch {
      settleMs = 1000;
    }
    this.addTimer = setTimeout(() => {
      this.addTimer = null;
      void this.flushAddedItems();
    }, settleMs);
  }

  private async flushAddedItems() {
    if (this.disposed || this.addFlushRunning) return;
    this.addFlushRunning = true;
    try {
      while (!this.disposed && this.pendingItemIDs.size > 0) {
        const rawIDs = Array.from(this.pendingItemIDs);
        this.pendingItemIDs.clear();

        // Startup/periodic already covers the library — wait, then re-resolve.
        if (this.activeRun) await this.activeRun;
        if (this.disposed) return;

        const parentIDs = expandAddedItemIDs(rawIDs, (id) => {
          try {
            return Zotero.Items.get(id) as Zotero.Item;
          } catch {
            return null;
          }
        });
        if (!parentIDs.length) continue;

        const loaded = Zotero.Items.get(parentIDs) as unknown;
        const items = (Array.isArray(loaded) ? loaded : [loaded]).filter(
          Boolean,
        ) as Zotero.Item[];
        if (!items.length) continue;

        await appendAuditEvent({
          run: `add-coalesce-${Date.now()}`,
          action: "add-coalesce",
          outcome: "info",
          detail: `flush ${items.length} item(s) from ${rawIDs.length} notifier id(s)`,
        });

        this.activeRun = this.performItems(items, "add", false).finally(() => {
          this.activeRun = null;
        });
        await this.activeRun;
      }
    } finally {
      this.addFlushRunning = false;
      if (!this.disposed && this.pendingItemIDs.size > 0) {
        this.scheduleAddedItems();
      }
    }
  }

  private async performRun(reason: string): Promise<ReconcileStats> {
    const libraryID = (Zotero.Libraries as any).userLibraryID;
    const items = (await (Zotero.Items as any).getAll(
      libraryID,
      true,
      false,
    )) as Zotero.Item[];
    return this.performItems(items, reason, true);
  }

  private async performItems(
    items: Zotero.Item[],
    reason: string,
    forceIndex: boolean,
  ): Promise<ReconcileStats> {
    const stats: ReconcileStats = {
      scanned: 0,
      attached: 0,
      review: 0,
      skipped: 0,
      errors: 0,
      created: 0,
      planned: 0,
    };
    const source = new LocalFolderSource();
    if (this.disposed || !source.isEnabled()) return stats;

    const runID = `${reason}-${Date.now()}`;
    const dryRun = getPref("pdf.dryRun") === true;
    ztoolkit.log(`PDF reconcile started (${reason})`);
    await appendAuditEvent({
      run: runID,
      action: "reconcile-start",
      outcome: "info",
      detail: dryRun ? "Dry-run enabled" : reason,
    });
    const index = await buildIndex(forceIndex);
    if (this.disposed) return stats;
    const indexComplete = isFolderIndexComplete();
    if (!indexComplete) {
      const meta = getLastIndexBuildMeta();
      await appendAuditEvent({
        run: runID,
        action: "index-incomplete",
        outcome: "review",
        detail: `Folder index incomplete (${meta.truncateReason || "unknown"}); OA auto-download suppressed`,
      });
      ztoolkit.log(
        `PDF reconcile: incomplete index — OA suppressed (reason=${meta.truncateReason})`,
      );
    }
    const allowOnline =
      indexComplete &&
      getPref("pdf.onlineAutoDownload") !== false &&
      (reason === "add" || getPref("pdf.onlineOnReconcile") === true);
    // Cap the number of online lookups per run — on EVERY path, including
    // "add". A bulk import must not fire an unbounded burst of OA requests
    // (slow + rate-limit/IP-block risk); it is limited to onlineMaxPerRun too.
    const onlineCap = Math.max(
      0,
      Math.min(100, Number(getPref("pdf.onlineMaxPerRun") ?? 10) || 10),
    );
    let onlineBudget =
      reason === "add" ? Math.min(items.length, onlineCap) : onlineCap;

    // Files already claimed by an earlier item in THIS run. Prevents two
    // different items from both being linked to the same PDF (a collision that
    // usually means a duplicate item or a wrong match).
    const usedPaths = new Set<string>();

    for (const item of items) {
      if (this.disposed) break;
      stats.scanned++;
      if (!canReconcileItem(item)) {
        stats.skipped++;
        continue;
      }

      try {
        const match = source.matchItem(item, index);
        if (match.status === "ambiguous" || match.status === "review") {
          if (!dryRun) await addAutomationTag(item, "#pdf-review");
          const detail =
            match.status === "review"
              ? dryRun
                ? `Dry-run: mid-confidence match (${match.score?.toFixed(2) ?? "?"}); review tag not added`
                : `Mid-confidence match (${match.reason}); tagged #pdf-review`
              : dryRun
                ? "Dry-run: ambiguous match; review tag not added"
                : "Ambiguous match; tagged #pdf-review";
          await appendAuditEvent({
            run: runID,
            action: "local-match",
            outcome: "review",
            itemID: item.id,
            title: item.getDisplayTitle(),
            path: match.status === "review" ? match.file?.path : undefined,
            detail,
          });
          stats.review++;
          continue;
        }
        if (match.status === "matched") {
          const filePath = match.file.path;
          // Cross-item collision: this file was already matched to another
          // item in this run. Don't attach it twice — route to review.
          if (usedPaths.has(filePath)) {
            if (!dryRun) await addAutomationTag(item, "#pdf-review");
            await appendAuditEvent({
              run: runID,
              action: "local-match",
              outcome: "review",
              itemID: item.id,
              title: item.getDisplayTitle(),
              path: filePath,
              detail: dryRun
                ? "Dry-run: file collides with another item's match"
                : "File already matched to another item; tagged #pdf-review",
            });
            stats.review++;
            continue;
          }
          usedPaths.add(filePath); // reserve this file for this item

          if (dryRun) {
            stats.planned++;
            await appendAuditEvent({
              run: runID,
              action: "local-attach",
              outcome: "planned",
              itemID: item.id,
              title: item.getDisplayTitle(),
              path: filePath,
              source: "local",
              detail: "Dry-run: linked attachment was not created",
            });
            continue;
          }
          const attachment = await source.attachFile(item, match.file);
          if (attachment) {
            await addAutomationTag(item, "#auto-attached");
            stats.attached++;
            await appendAuditEvent({
              run: runID,
              action: "local-attach",
              outcome: "success",
              itemID: item.id,
              title: item.getDisplayTitle(),
              path: filePath,
              source: "local",
            });
          } else {
            usedPaths.delete(filePath); // attach failed → release the file
            stats.errors++;
            await appendAuditEvent({
              run: runID,
              action: "local-attach",
              outcome: "failed",
              itemID: item.id,
              title: item.getDisplayTitle(),
              path: filePath,
              source: "local",
            });
          }
          continue;
        }

        if (allowOnline && onlineBudget > 0) {
          onlineBudget--;
          if (dryRun) {
            stats.planned++;
            await appendAuditEvent({
              run: runID,
              action: "online-lookup",
              outcome: "planned",
              itemID: item.id,
              title: item.getDisplayTitle(),
              detail: "Dry-run: OA sources were not contacted",
            });
            continue;
          }
          const online = await tryAutomaticOnlineSources(item);
          if (online) {
            await addAutomationTag(item, "#auto-attached");
            await addAutomationTag(item, "#auto-oa");
            stats.attached++;
            await appendAuditEvent({
              run: runID,
              action: "online-attach",
              outcome: "success",
              itemID: item.id,
              title: item.getDisplayTitle(),
              source: online.source,
            });
          }
        }
      } catch (e) {
        stats.errors++;
        ztoolkit.log(`PDF reconcile failed for item ${item.id}`, e);
        await appendAuditEvent({
          run: runID,
          action: "item-reconcile",
          outcome: "failed",
          itemID: item.id,
          title: item.getDisplayTitle(),
          detail: (e as Error)?.message || String(e),
        });
      }
    }

    if (!this.disposed && reason !== "add") {
      const orphanMode = normalizeOrphanMode(getPref("pdf.orphanMode"));
      if (orphanMode !== "off") {
        const orphanStats = await processOrphanPDFs(
          index,
          items,
          (Zotero.Libraries as any).userLibraryID,
          orphanMode,
          Number(getPref("pdf.orphanMaxPerRun") ?? 10),
          dryRun,
          runID,
          "automatic",
        );
        stats.created += orphanStats.created;
        stats.planned += orphanStats.planned;
        stats.errors += orphanStats.failed;
      }
    }

    ztoolkit.log(`PDF reconcile finished (${reason})`, stats);
    await appendAuditEvent({
      run: runID,
      action: "reconcile-finish",
      outcome: stats.errors ? "failed" : dryRun ? "planned" : "success",
      detail: JSON.stringify(stats),
    });
    if (dryRun && reason === "manual") {
      try {
        await openAutomationAuditReport();
      } catch (e) {
        ztoolkit.log("Could not open dry-run audit report", e);
      }
    }
    return stats;
  }
}
