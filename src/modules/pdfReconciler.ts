// @ajan: cursor · @etiket: katman-2, p2, reconciler, match-via, match-tag-clear
import { getPref } from "../utils/prefs";
import {
  buildIndex,
  getLastIndexBuildMeta,
  isFolderIndexComplete,
} from "./folderIndex";
import { LocalFolderSource } from "./pdfSources";
import { tryAutomaticOnlineSources } from "./pdfDownload";
import {
  processOrphanPDFs,
  normalizeOrphanMode,
  mergeKnownSourcePaths,
} from "./orphanProcessor";
import { appendAuditEvent, openAutomationAuditReport } from "./automationAudit";
import { runWithAbortSignal, isRunAborted } from "../utils/cancelToken";
import {
  DEFAULT_LIBRARY_BATCH_SIZE,
  iterateLibraryItemBatches,
  normalizeLibraryBatchSize,
} from "../utils/libraryIterate";

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
  private runAbort: AbortController | null = null;

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

  /** Abort in-flight reconcile / add flush / orphan scan (manual Cancel). */
  cancel(reason = "user-cancel") {
    ztoolkit.log(`PDF reconcile cancel requested (${reason})`);
    try {
      this.runAbort?.abort();
    } catch {
      /* ignore */
    }
  }

  isBusy() {
    return !!this.activeRun || this.addFlushRunning;
  }

  async processOrphansNow() {
    if (this.activeRun) await this.activeRun;
    if (this.disposed) return null;
    const runID = `manual-orphans-${Date.now()}`;
    const libraryID = (Zotero.Libraries as any).userLibraryID;
    const batchSize = normalizeLibraryBatchSize(
      getPref("pdf.libraryBatchSize") ?? DEFAULT_LIBRARY_BATCH_SIZE,
    );
    const controller = new AbortController();
    this.runAbort?.abort();
    this.runAbort = controller;
    try {
      const index = await buildIndex(true, undefined, controller.signal);
      if (this.disposed || controller.signal.aborted) return null;
      const knownPaths = new Set<string>();
      for await (const batch of iterateLibraryItemBatches(libraryID, {
        batchSize,
        signal: controller.signal,
      })) {
        if (this.disposed || controller.signal.aborted) break;
        await mergeKnownSourcePaths(batch, knownPaths);
      }
      if (this.disposed || controller.signal.aborted) return null;
      return processOrphanPDFs(
        index,
        knownPaths,
        libraryID,
        "autoCreate",
        Number(getPref("pdf.orphanMaxPerRun") ?? 10),
        getPref("pdf.dryRun") === true,
        runID,
        "manual",
      );
    } finally {
      if (this.runAbort === controller) this.runAbort = null;
    }
  }

  dispose() {
    this.disposed = true;
    try {
      this.runAbort?.abort();
    } catch {
      /* ignore */
    }
    this.runAbort = null;
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

        const controller = new AbortController();
        this.runAbort?.abort();
        this.runAbort = controller;
        this.activeRun = runWithAbortSignal(controller.signal, () =>
          this.performItems(items, "add", false, controller.signal),
        )
          .catch((e) => {
            if ((e as Error)?.name === "RunAbortedError") {
              ztoolkit.log("PDF reconcile aborted (add)");
              return {
                scanned: 0,
                attached: 0,
                review: 0,
                skipped: 0,
                errors: 0,
                created: 0,
                planned: 0,
              } satisfies ReconcileStats;
            }
            throw e;
          })
          .finally(() => {
            if (this.runAbort === controller) this.runAbort = null;
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
    const batchSize = normalizeLibraryBatchSize(
      getPref("pdf.libraryBatchSize") ?? DEFAULT_LIBRARY_BATCH_SIZE,
    );
    const controller = new AbortController();
    this.runAbort?.abort();
    this.runAbort = controller;

    const empty: ReconcileStats = {
      scanned: 0,
      attached: 0,
      review: 0,
      skipped: 0,
      errors: 0,
      created: 0,
      planned: 0,
    };

    try {
      return await runWithAbortSignal(controller.signal, async () => {
        const source = new LocalFolderSource();
        if (this.disposed || !source.isEnabled()) return empty;

        const runID = `${reason}-${Date.now()}`;
        const dryRun = getPref("pdf.dryRun") === true;
        ztoolkit.log(`PDF reconcile started (${reason})`);
        await appendAuditEvent({
          run: runID,
          action: "reconcile-start",
          outcome: "info",
          detail: dryRun ? "Dry-run enabled" : reason,
        });

        const index = await buildIndex(true, undefined, controller.signal);
        if (this.disposed || isRunAborted(controller.signal)) return empty;

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
        const onlineCap = Math.max(
          0,
          Math.min(100, Number(getPref("pdf.onlineMaxPerRun") ?? 10) || 10),
        );
        const shared: ItemBatchShared = {
          runID,
          reason,
          dryRun,
          source,
          index,
          allowOnline,
          usedPaths: new Set<string>(),
          onlineBudget: onlineCap,
          signal: controller.signal,
          stats: { ...empty },
        };

        const orphanMode = normalizeOrphanMode(getPref("pdf.orphanMode"));
        const collectOrphans = reason !== "add" && orphanMode !== "off";
        const knownPaths = new Set<string>();

        for await (const batch of iterateLibraryItemBatches(libraryID, {
          batchSize,
          signal: controller.signal,
        })) {
          if (this.disposed || isRunAborted(controller.signal)) break;
          if (collectOrphans) await mergeKnownSourcePaths(batch, knownPaths);
          await this.processItemBatch(batch, shared);
        }

        if (
          !this.disposed &&
          !isRunAborted(controller.signal) &&
          collectOrphans
        ) {
          const orphanStats = await processOrphanPDFs(
            index,
            knownPaths,
            libraryID,
            orphanMode,
            Number(getPref("pdf.orphanMaxPerRun") ?? 10),
            dryRun,
            runID,
            "automatic",
          );
          shared.stats.created += orphanStats.created;
          shared.stats.planned += orphanStats.planned;
          shared.stats.errors += orphanStats.failed;
        }

        ztoolkit.log(`PDF reconcile finished (${reason})`, shared.stats);
        await appendAuditEvent({
          run: runID,
          action: "reconcile-finish",
          outcome: shared.stats.errors
            ? "failed"
            : dryRun
              ? "planned"
              : "success",
          detail: JSON.stringify(shared.stats),
        });
        if (dryRun && reason === "manual") {
          try {
            await openAutomationAuditReport();
          } catch (e) {
            ztoolkit.log("Could not open dry-run audit report", e);
          }
        }
        return shared.stats;
      });
    } catch (e) {
      if ((e as Error)?.name === "RunAbortedError") {
        ztoolkit.log(`PDF reconcile aborted (${reason})`);
        return empty;
      }
      throw e;
    } finally {
      if (this.runAbort === controller) this.runAbort = null;
    }
  }

  /** Small-list path for add-notifier coalesce (already loaded items). */
  private async performItems(
    items: Zotero.Item[],
    reason: string,
    forceIndex: boolean,
    signal?: AbortSignal,
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
    const index = await buildIndex(forceIndex, undefined, signal);
    if (this.disposed || isRunAborted(signal)) return stats;
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
    const onlineCap = Math.max(
      0,
      Math.min(100, Number(getPref("pdf.onlineMaxPerRun") ?? 10) || 10),
    );
    const shared: ItemBatchShared = {
      runID,
      reason,
      dryRun,
      source,
      index,
      allowOnline,
      usedPaths: new Set<string>(),
      onlineBudget:
        reason === "add" ? Math.min(items.length, onlineCap) : onlineCap,
      signal,
      stats,
    };

    await this.processItemBatch(items, shared);

    if (!this.disposed && !isRunAborted(signal) && reason !== "add") {
      const orphanMode = normalizeOrphanMode(getPref("pdf.orphanMode"));
      if (orphanMode !== "off") {
        const knownPaths = await mergeKnownSourcePaths(items);
        const orphanStats = await processOrphanPDFs(
          index,
          knownPaths,
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

  private async processItemBatch(
    items: Zotero.Item[],
    shared: ItemBatchShared,
  ): Promise<void> {
    const {
      runID,
      dryRun,
      source,
      index,
      allowOnline,
      usedPaths,
      signal,
      stats,
    } = shared;

    for (const item of items) {
      if (this.disposed || isRunAborted(signal)) break;
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
          usedPaths.add(filePath);

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
          const attachment = await source.attachFile(
            item,
            match.file,
            match.via || "title",
          );
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
            usedPaths.delete(filePath);
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

        if (allowOnline && shared.onlineBudget > 0) {
          shared.onlineBudget--;
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
          if (online && "stopped" in online) {
            stats.review++;
            await appendAuditEvent({
              run: runID,
              action: "online-attach",
              outcome: "review",
              itemID: item.id,
              title: item.getDisplayTitle(),
              detail: `Cascade stopped (${online.stopped}); quarantine kept`,
            });
            continue;
          }
          if (online && "source" in online && online.attachment) {
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
        if ((e as Error)?.name === "RunAbortedError") break;
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
  }
}

type ItemBatchShared = {
  runID: string;
  reason: string;
  dryRun: boolean;
  source: LocalFolderSource;
  index: Awaited<ReturnType<typeof buildIndex>>;
  allowOnline: boolean;
  usedPaths: Set<string>;
  onlineBudget: number;
  signal?: AbortSignal | null;
  stats: ReconcileStats;
};
