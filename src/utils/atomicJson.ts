// @ajan: cursor · @etiket: katman-2, p1, atomic-json
/**
 * Atomic JSON persistence for Zotero's IOUtils sandbox.
 * Write to a sibling temp file, then move over the target (replace).
 *
 * IO is injectable for crash/quarantine unit tests outside Zotero.
 */

export type AtomicJsonIO = {
  exists: (path: string) => Promise<boolean>;
  readUTF8: (path: string) => Promise<string>;
  writeUTF8: (path: string, text: string) => Promise<void>;
  move: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
};

declare const IOUtils: any;

const defaultIO: AtomicJsonIO = {
  exists: (p) => IOUtils.exists(p),
  readUTF8: (p) => IOUtils.readUTF8(p),
  writeUTF8: (p, t) => IOUtils.writeUTF8(p, t),
  move: (a, b) => IOUtils.move(a, b),
  remove: (p) => IOUtils.remove(p),
};

let io: AtomicJsonIO = defaultIO;

/** @internal */
export function __setAtomicJsonIOForTests(next: AtomicJsonIO | null): void {
  io = next || defaultIO;
}

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
    await io.writeUTF8(tmp, text);
    await io.move(tmp, path);
  } catch (e) {
    try {
      await io.remove(tmp);
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
    if (!(await io.exists(path))) return null;
    const raw = await io.readUTF8(path);
    return JSON.parse(raw);
  } catch (e) {
    try {
      if (await io.exists(path)) {
        await io.move(path, `${path}.corrupt-${Date.now()}`);
      }
    } catch {
      /* quarantine best-effort */
    }
    throw e;
  }
}
