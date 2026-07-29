import { getPref } from "./prefs";

/**
 * 快捷键是否启用（设置面板中的勾选框，未勾选表示不启用）
 */
export function isShortcutEnabled(prefKey: string) {
  return getPref(`${prefKey}.enable`) !== false;
}

/**
 * 读取快捷键的显示文本，如 "Ctrl + I"；未设置返回空字符串
 */
export function getShortcutText(prefKey: string) {
  const shortcut = getPref(prefKey);
  return typeof shortcut === "string" ? shortcut.trim() : "";
}

function normalizeKey(key: string) {
  return key
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .replace(/[ıİ]/g, "i")
    .toLowerCase();
}

function parseShortcut(raw: string) {
  const parts = raw
    .split(/\s*\+\s*/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const modifiers = new Set(parts.slice(0, -1));
  return {
    alt: modifiers.has("alt") || modifiers.has("option"),
    control: modifiers.has("ctrl") || modifiers.has("control"),
    meta:
      modifiers.has("meta") || modifiers.has("cmd") || modifiers.has("command"),
    shift: modifiers.has("shift"),
    key: normalizeKey(parts.at(-1) || ""),
  };
}

export function shortcutMatchesEvent(raw: string, event: KeyboardEvent) {
  const shortcut = parseShortcut(raw);
  if (!shortcut.key) return false;

  let eventKey = normalizeKey(event.key || "");
  const codeMatch = /^Key([A-Z])$/.exec(event.code || "");
  if (codeMatch && shortcut.key === codeMatch[1].toLowerCase()) {
    eventKey = shortcut.key;
  }

  return (
    shortcut.key === eventKey &&
    shortcut.alt === event.altKey &&
    shortcut.control === event.ctrlKey &&
    shortcut.meta === event.metaKey &&
    shortcut.shift === event.shiftKey
  );
}

export function registerShortcut(
  prefKey: string,
  callback: () => void | Promise<void>,
) {
  ztoolkit.Keyboard.register(async (ev, options) => {
    // The toolkit only supplies options.keyboard on keyup. Browser/Zotero
    // commands can move focus before keyup, so match and consume shortcuts on
    // keydown directly.
    if (options.type !== "keydown" || ev.repeat) return;
    if (!isShortcutEnabled(prefKey)) return;
    const raw = getShortcutText(prefKey);
    if (!raw || !shortcutMatchesEvent(raw, ev)) return;

    ev.preventDefault();
    ev.stopPropagation();
    await callback();
  });
}

export function listenShortcut(
  inputNode: HTMLInputElement,
  callback: (shortcut: string) => void,
) {
  inputNode.addEventListener("keydown", (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const shortcut: any = {};
    shortcut.control = e.ctrlKey;
    shortcut.meta = e.metaKey;
    shortcut.shift = e.shiftKey;
    shortcut.alt = e.altKey;
    if (!["Shift", "Meta", "Ctrl", "Alt", "Control"].includes(e.key)) {
      shortcut.key = e.key.toUpperCase();
    }
    const keys: string[] = [];
    if (shortcut.control) {
      keys.push("Ctrl");
    }
    if (shortcut.meta) {
      keys.push("Meta");
    }
    if (shortcut.shift) {
      keys.push("Shift");
    }
    if (shortcut.alt) {
      keys.push("Alt");
    }
    window.setTimeout(() => {
      inputNode.value = [...keys, ...[shortcut.key]]
        .filter(Boolean)
        .join(" + ");
      ztoolkit.log(keys, shortcut, inputNode.value);
      callback(inputNode.value);
    });
  });
}
