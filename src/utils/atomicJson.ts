// @ajan: cursor · @etiket: katman-2, p1, atomic-json
/**
 * Atomic JSON persistence for Zotero's IOUtils sandbox.
 * Write to a sibling temp file, then move over the target (replace).
 */

declare const IOUtils: any;

export type AtomicJsonEnvelope<T> = {
  schemaVersion: number;
  generation: number;
  savedAt: string;
  data: T;
};

export async function writeUtf8Atomic(
  path: string,
  text: string,
): Promise<void> {
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await IOUtils.writeUTF8(tmp, text);
    await IOUtils.move(tmp, path);
  } catch (e) {
    try {
      await IOUtils.remove(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await writeUtf8Atomic(path, JSON.stringify(value));
}

/**
 * Read JSON; on parse/IO failure rename the file to `.corrupt-*` and return null
 * so callers do not silently erase history without a recoverable artifact.
 */
export async function readJsonOrQuarantine(
  path: string,
): Promise<unknown | null> {
  try {
    if (!(await IOUtils.exists(path))) return null;
    const raw = await IOUtils.readUTF8(path);
    return JSON.parse(raw);
  } catch (e) {
    try {
      if (await IOUtils.exists(path)) {
        await IOUtils.move(path, `${path}.corrupt-${Date.now()}`);
      }
    } catch {
      /* quarantine best-effort */
    }
    throw e;
  }
}
