// Валюта и формат цены. Общий для обоих приложений, без React и без Telegram.
//
// Цены в базе — целые рубли (services.price, bookings.price). Символ валюты
// нигде больше не пишется руками: и экраны, и тексты сообщений берут его
// отсюда.

export const CURRENCY = "₽";

// Конструктор Intl.NumberFormat дорогой — создаём форматтер один раз.
// ru-RU разделяет тысячи неразрывным пробелом: «2 500».
const fPrice = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** 2500 → "2 500 ₽" (неразрывные пробелы). Не число — пустая строка. */
export function formatPrice(n) {
  const v = Number(n);
  if (n == null || n === "" || !Number.isFinite(v)) return "";
  return `${fPrice.format(v)} ${CURRENCY}`;
}
