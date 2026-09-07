// Тонкая обёртка над window.Telegram.WebApp.
// SDK подключён <script>-тегом в index.html, npm-пакета нет.
// В обычном браузере window.Telegram === undefined — поэтому ВСЁ через ?.

// Контент читаем во время вызова, а не при загрузке модуля: имя и логин
// мастера лежат в базе и меняются из админки прямо во время работы.
import { contentSnapshot } from "./content.js";

export const tg = () => window.Telegram?.WebApp;

export const tgUser = () => window.Telegram?.WebApp?.initDataUnsafe?.user ?? null;

/** Есть ли нативная кнопка «назад» — считаем один раз при загрузке модуля. */
export const HAS_TG_BACK = Boolean(window.Telegram?.WebApp?.BackButton);

/**
 * Параметр из ссылки t.me/<bot>/<app>?startapp=… — им открывается админка.
 * Обычный initDataUnsafe, гейт по версии не нужен; в браузере null.
 */
export const START_PARAM =
  window.Telegram?.WebApp?.initDataUnsafe?.start_param ?? null;

/** Версия клиента не ниже v. */
export function atLeast(v) {
  return window.Telegram?.WebApp?.isVersionAtLeast?.(v) === true;
}

const masterName = () => contentSnapshot().settings?.masterName || "мастер";
const masterUsername = () => contentSnapshot().settings?.masterUsername || "";

/** Логин мастера не задан — кнопки отправки заявок работать не будут. */
export function masterNotSet() {
  return !masterUsername();
}

export function init() {
  const w = tg();
  if (!w) return;
  w.ready();
  w.expand();
  // 7.7+: свайп вниз при скролле длинного списка слотов не закрывает приложение
  if (atLeast("7.7")) w.disableVerticalSwipes?.();
}

/**
 * Красит фон и шапку клиента в цвет приложения. Палитра у нас своя,
 * и без этого вокруг мини-аппа остаётся тема Telegram — стык заметен.
 *
 * Цвет читаем из уже применённых токенов, чтобы он жил только в CSS.
 * Шапка: до 6.9 setHeaderColor принимал лишь ключевые слова, не hex.
 */
export function syncChrome() {
  const w = tg();
  if (!w) return;
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return;
  if (atLeast("6.1")) w.setBackgroundColor?.(bg);
  if (atLeast("6.9")) w.setHeaderColor?.(bg);
  if (atLeast("7.10")) w.setBottomBarColor?.(bg);
}

export function showAlert(message) {
  const w = tg();
  if (w?.showAlert && atLeast("6.2")) w.showAlert(message);
  else window.alert(message);
}

export function showConfirm(message, cb) {
  const w = tg();
  if (w?.showConfirm && atLeast("6.2")) w.showConfirm(message, cb);
  else cb(window.confirm(message));
}

export function haptic(type = "light") {
  const h = window.Telegram?.WebApp?.HapticFeedback;
  if (!h || !atLeast("6.1")) return;
  if (type === "success" || type === "error" || type === "warning") {
    h.notificationOccurred?.(type);
  } else if (type === "select") {
    h.selectionChanged?.();
  } else {
    h.impactOccurred?.(type); // light | medium | heavy
  }
}

/** Внешняя ссылка (карта). */
export function openLink(url) {
  const w = tg();
  if (w?.openLink) w.openLink(url);
  else window.open(url, "_blank", "noopener");
}

/**
 * Открывает чат с мастером с уже набранным текстом.
 * Возвращает true, если ссылку взял Telegram, false — если обычный браузер.
 *
 * ⚠️ openTelegramLink обычно ЗАКРЫВАЕТ мини-апп. Всё, что нужно сохранить,
 * сохраняйте ДО вызова, а не после и не в .then().
 */
export function sendToMaster(text) {
  const username = masterUsername();
  if (!username) {
    showAlert(
      "⚠️ Не указан Telegram мастера.\nОткройте «Настройки» → «Контакты и адрес» и впишите логин."
    );
    return true;
  }
  const url = "https://t.me/" + username + "?text=" + encodeURIComponent(text);
  const w = tg();
  if (w?.openTelegramLink) {
    w.openTelegramLink(url);
    return true;
  }
  window.open(url, "_blank", "noopener");
  return false;
}

/** Скопировать текст в буфер. Возвращает false, если буфер недоступен. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ─── Шаблоны сообщений мастеру ──────────────────────────────────

function signature() {
  const u = tgUser();
  if (!u) return "";
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  const uname = u.username ? ` (@${u.username})` : "";
  return `\n\n👤 ${name}${uname}`;
}

export function bookingMessage(b) {
  return (
    `Здравствуйте, ${masterName()}! 🌸\n` +
    `Хочу записаться:\n\n` +
    `💅 Услуга: ${b.serviceName}\n` +
    `📅 Дата: ${b.dateLabel}\n` +
    `🕒 Время: ${b.time}\n` +
    `⏳ Длительность: ${b.duration} мин\n` +
    `💰 Стоимость: ${b.price} ₾` +
    (b.comment ? `\n\n💬 Комментарий: ${b.comment}` : "") +
    signature()
  );
}

export function waitlistMessage(w) {
  return (
    `Здравствуйте, ${masterName()}! 🌸\n` +
    `Хочу в лист ожидания — напишите, пожалуйста, если появится окошко.\n\n` +
    `💅 Услуга: ${w.serviceName}\n` +
    `📅 Удобные дни: ${w.daysLabel}\n` +
    `🕒 Удобное время: ${w.timeLabel}` +
    (w.comment ? `\n\n💬 Комментарий: ${w.comment}` : "") +
    signature()
  );
}

export function cancelMessage(b) {
  return (
    `Здравствуйте, ${masterName()}!\n` +
    `Хочу отменить запись:\n\n` +
    `💅 ${b.serviceName}\n` +
    `📅 ${b.dateLabel}, 🕒 ${b.time}` +
    signature()
  );
}

export function greetingMessage() {
  return `Здравствуйте, ${masterName()}! 🌸`;
}
