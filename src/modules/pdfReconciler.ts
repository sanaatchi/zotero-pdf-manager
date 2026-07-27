import { getPref } from "../utils/prefs";
import { buildIndex } from "./folderIndex";
import { LocalFolderSource } from "./pdfSources";
import { tryAutomaticOnlineSources } from "./pdfDownload";
import { processOrphanPDFs } from "./orphanProcessor";
import { appendAuditEvent } from "./automationAudit";

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
 */
export class PDFReconciler {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private addTimer: ReturnType<typeof setTimeout> | null = null;
  private activeRun: Promise<ReconcileStats> | null = null;
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
    );
  }

  dispose() {
    this.disposed = true;
    this.disposeTimers();
    this.pendingItemIDs.clear();
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = "";
    }
  }

  private disposeTimers() {
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    if (this.periodicTimer !== null) clearInterval(this.periodicTimer);
    if (this.addTimer !== null) clearTimeout(this.addTimer);
    this.startupTimer = null;
    this.periodicTimer = null;
    this.addTimer = null;
  }

  private registerNotifier() {
    if (this.notifierID) return;
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (
          event: string,
          type: string,
          ids: (string | number)[],
        ) => {
          if (this.disposed || event !== "add" || type !== "item") return;
          for (const id of ids) {
            const numericID = Number(id);
            if (Number.isFinite(numericID)) this.pendingItemIDs.add(numericID);
          }
          this.scheduleAddedItems();
        },
      },
      ["item"],
      "zotero-pdf-manager-auto-reconcile",
    );
  }

  private scheduleAddedItems() {
    if (this.addTimer !== null) clearTimeout(this.addTimer);
    this.addTimer = setTimeout(() => {
      this.addTimer = null;
      void this.flushAddedItems();
    }, 1000);
  }

  private async flushAddedItems() {
    if (this.disposed || !this.pendingItemIDs.size) return;
    const ids = Array.from(this.pendingItemIDs);
    this.pendingItemIDs.clear();

    // A startup/periodic run already covers these records. Wait for it rather
    // than racing attachment creation, then re-check eligibility.
    if (this.activeRun) await this.activeRun;
    if (this.disposed) return;

    const loaded = Zotero.Items.get(ids) as unknown;
    const items = (Array.isArray(loaded) ? loaded : [loaded]).filter(
      Boolean,
    ) as Zotero.Item[];
    this.activeRun = this.performItems(items, "add", false).finally(() => {
      this.activeRun = null;
    });
    await this.activeRun;
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
    const allowOnline =
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
        if (match.status === "ambiguous") {
          if (!dryRun) await addAutomationTag(item, "#pdf-review");
          await appendAuditEvent({
            run: runID,
            action: "local-match",
            outcome: "review",
            itemID: item.id,
            title: item.getDisplayTitle(),
            detail: dryRun
              ? "Dry-run: ambiguous match; review tag not added"
              : "Ambiguous match; tagged #pdf-review",
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

    if (!this.disposed && reason !== "add" && getPref("pdf.orphanMode") !== "off") {
      const orphanStats = await processOrphanPDFs(
        index,
        items,
        (Zotero.Libraries as any).userLibraryID,
        // Automatic reconciliation may report orphans, but creation is only
        // allowed through processOrphansNow(), an explicit user action.
        "report",
        Number(getPref("pdf.orphanMaxPerRun") ?? 10),
        dryRun,
        runID,
      );
      stats.created += orphanStats.created;
      stats.planned += orphanStats.planned;
      stats.errors += orphanStats.failed;
    }

    ztoolkit.log(`PDF reconcile finished (${reason})`, stats);
    await appendAuditEvent({
      run: runID,
      action: "reconcile-finish",
      outcome: stats.errors ? "failed" : dryRun ? "planned" : "success",
      detail: JSON.stringify(stats),
    });
    return stats;
  }
}
