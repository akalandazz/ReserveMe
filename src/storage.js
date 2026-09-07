// Хранение заявок клиента.
//
// Основное хранилище — Telegram CloudStorage (Bot API 6.9+): переживает
// переустановку, привязано к аккаунту. Фолбэк — localStorage: работает
// в обычном браузере и на старых клиентах.
//
// Записи видны ТОЛЬКО клиенту. Мастер узнаёт о них из сообщения в чате.

/** Ключ CloudStorage: разрешены только A-Za-z0-9_- */
const KEY = "vs_bookings_v1";

/** Лимит значения CloudStorage — 4096 символов. ~110 символов на запись. */
const MAX_RECORDS = 25;

function cloud() {
  const w = window.Telegram?.WebApp;
  if (!w?.CloudStorage) return null;
  if (!w.isVersionAtLeast?.("6.9")) return null;
  return w.CloudStorage;
}

/**
 * Промисификация колбэчного API с таймаутом.
 * Таймаут обязателен: на некоторых клиентах колбэк не приходит вообще,
 * и экран «Мои записи» навсегда завис бы на «Загрузка…».
 * undefined в результате означает «не сработало, идём в фолбэк».
 */
function promisify(fn, ms = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    setTimeout(() => finish(undefined), ms);
    try {
      fn(finish);
    } catch {
      finish(undefined);
    }
  });
}

async function readRaw() {
  const cs = cloud();
  if (cs) {
    const v = await promisify((done) =>
      // getItem отдаёт "" для отсутствующего ключа — это не ошибка
      cs.getItem(KEY, (err, value) => done(err ? undefined : value || ""))
    );
    if (v !== undefined) return v;
  }
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

async function writeRaw(raw) {
  // В localStorage пишем всегда: сбой CloudStorage не должен терять запись
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // приватный режим — молча пропускаем
  }
  const cs = cloud();
  if (!cs) return;
  await promisify((done) => cs.setItem(KEY, raw, () => done(true)));
}

export async function loadBookings() {
  const raw = await readRaw();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // повреждённые данные не должны ронять экран
  }
}

export async function saveBookings(list) {
  const trimmed = list.slice(-MAX_RECORDS);
  await writeRaw(JSON.stringify(trimmed));
  return trimmed;
}

export async function addBooking(booking) {
  const list = await loadBookings();
  return saveBookings([...list, booking]);
}

export async function removeBooking(id) {
  const list = await loadBookings();
  return saveBookings(list.filter((b) => b.id !== id));
}
