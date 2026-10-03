import { expect, test } from "@playwright/test";
import { CURRENCY, formatPrice } from "../../src/money.js";

// Формат цены (src/money.js) — один на оба приложения и тексты сообщений.
// Пробелы неразрывные: «2 500 ₽» не должно переноситься посередине.

const NBSP = " ";

test("валюта — рубль", () => {
  expect(CURRENCY).toBe("₽");
});

test("цена без разрядов", () => {
  expect(formatPrice(0)).toBe(`0${NBSP}₽`);
  expect(formatPrice(75)).toBe(`75${NBSP}₽`);
});

test("тысячи отделены неразрывным пробелом", () => {
  expect(formatPrice(2500)).toBe(`2${NBSP}500${NBSP}₽`);
  expect(formatPrice(99999)).toBe(`99${NBSP}999${NBSP}₽`);
});

test("строка с числом — как число", () => {
  expect(formatPrice("1500")).toBe(`1${NBSP}500${NBSP}₽`);
});

test("нет цены — пустая строка, а не « ₽»", () => {
  expect(formatPrice(null)).toBe("");
  expect(formatPrice(undefined)).toBe("");
  expect(formatPrice("")).toBe("");
  expect(formatPrice("abc")).toBe("");
});
