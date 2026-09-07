// Светлая/тёмная тема приложения.
//
// Палитра у приложения своя (см. :root в index.css), поэтому тему
// выбираем сами: по умолчанию повторяем colorScheme клиента Telegram,
// а кнопка в шапке ставит ручное переопределение и запоминает его.
//
// Наружу выставляем ровно один атрибут — data-theme на <html>.

import { syncChrome } from "./telegram.js";

const KEY = "vs_theme_v1";

/** "light" | "dark" | null (null — следуем за клиентом/системой) */
let manual = readStored();
let started = false;
const listeners = new Set();

function readStored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // приватный режим
  }
}

/** Тема клиента Telegram, а в обычном браузере — системная. */
function fromClient() {
  const scheme = window.Telegram?.WebApp?.colorScheme;
  if (scheme === "light" || scheme === "dark") return scheme;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
    ? "dark"
    : "light";
}

export function currentTheme() {
  return manual ?? fromClient();
}

function apply() {
  const next = currentTheme();
  if (document.documentElement.dataset.theme !== next) {
    document.documentElement.dataset.theme = next;
  }
  // цвет шапки клиента берём уже из применённых токенов
  syncChrome();
  listeners.forEach((fn) => fn());
}

/**
 * Вызывать один раз при старте. Флаг нужен из-за StrictMode: Telegram
 * не дедуплицирует onEvent, и второй вызов повесил бы обработчик дважды.
 */
export function initTheme() {
  apply();
  if (started) return;
  started = true;
  window.Telegram?.WebApp?.onEvent?.("themeChanged", apply);
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    ?.addEventListener?.("change", apply);
}

export function toggleTheme() {
  manual = currentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(KEY, manual);
  } catch {
    // приватный режим — тема просто не переживёт перезапуск
  }
  apply();
}

/** Подписка для useSyncExternalStore. */
export function subscribeTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
