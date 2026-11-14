import { expect, test } from "@playwright/test";
import {
  analyticsFor,
  deltaLabel,
  isVisit,
  monthTitle,
  monthTotals,
  monthVisits,
  periodRange,
  popularServices,
} from "../../src/admin/analytics.js";

// Аналитика кабинета (src/admin/analytics.js): визит — подтверждённая и
// уже начавшаяся запись, деньги — цена на самой записи. Часы — устройства,
// поэтому «сейчас» здесь всегда задано явно, в местном времени.

const NOW = new Date(2026, 10, 14, 12, 0); // 14 ноября 2026, 12:00

let nextId = 1;
function b(day, fields = {}) {
  return {
    id: nextId++,
    day,
    start_min: 600,
    status: "ok",
    price: 100,
    client_id: 1,
    client_name: "Анна",
    service_id: "manicure",
    service_name: "Маникюр",
    services: null,
    ...fields,
  };
}

const client = (id, name, extra = {}) => ({ id, name, ...extra });

test.describe("что считается визитом", () => {
  test("подтверждённая и прошедшая", () => {
    expect(isVisit(b("2026-11-13"), NOW)).toBe(true);
  });

  test("заявка и будущая запись — не визиты", () => {
    expect(isVisit(b("2026-11-13", { status: "new" }), NOW)).toBe(false);
    expect(isVisit(b("2026-11-15"), NOW)).toBe(false);
    // Сегодня: в 10:00 уже была, в 13:00 ещё нет.
    expect(isVisit(b("2026-11-14", { start_min: 600 }), NOW)).toBe(true);
    expect(isVisit(b("2026-11-14", { start_min: 780 }), NOW)).toBe(false);
  });

  test("отменённая — не визит", () => {
    expect(isVisit(b("2026-11-13", { status: "cancelled" }), NOW)).toBe(false);
  });
});

test.describe("периоды", () => {
  test("30 дней включая сегодня и такой же отрезок перед ними", () => {
    expect(periodRange("m", NOW)).toEqual({
      from: "2026-10-16",
      to: "2026-11-14",
      prev: { from: "2026-09-16", to: "2026-10-15" },
    });
  });

  test("«Всё» — без начала и без прошлого периода", () => {
    expect(periodRange("all", NOW)).toEqual({ from: null, to: "2026-11-14", prev: null });
  });
});

test.describe("Заработано", () => {
  test("цена записи, только визиты периода, изменение к прошлому", () => {
    const a = analyticsFor({
      now: NOW,
      clients: [client(1, "Анна")],
      bookings: [
        b("2026-11-10", { price: 150 }),
        b("2026-10-16", { price: 50 }), // первый день периода
        b("2026-10-15", { price: 100 }), // уже прошлый период
        b("2026-11-12", { price: 999, status: "new" }),
        b("2026-11-20", { price: 999 }),
      ],
    });
    expect(a.revenue).toBe(200);
    expect(a.visitCount).toBe(2);
    expect(a.avg).toBe(100);
    expect(a.clientCount).toBe(1);
    expect(a.delta).toBe(100);
    expect(deltaLabel(a.delta)).toBe("+100% к прошлому периоду");
  });

  test("изменение скрыто для «Всё» и при пустом прошлом периоде", () => {
    const bookings = [b("2026-11-10")];
    expect(analyticsFor({ now: NOW, clients: [], bookings, period: "m" }).delta).toBeNull();
    expect(analyticsFor({ now: NOW, clients: [], bookings, period: "all" }).delta).toBeNull();
    expect(deltaLabel(null)).toBe("");
  });

  test("падение — со знаком минус", () => {
    expect(deltaLabel(-8)).toBe("−8% к прошлому периоду");
  });

  test("без визитов средний чек — null", () => {
    expect(analyticsFor({ now: NOW, clients: [], bookings: [] }).avg).toBeNull();
  });
});

test.describe("по месяцам", () => {
  test("шесть месяцев до текущего, период не влияет", () => {
    const visits = [b("2026-11-01", { price: 70 }), b("2026-06-30", { price: 40 }), b("2026-05-31")];
    const months = monthTotals(visits, NOW);
    expect(months.map((m) => m.mk)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(months[0].total).toBe(40);
    expect(months[5]).toMatchObject({ total: 70, current: true });
  });

  test("переход через новый год", () => {
    const months = monthTotals([], new Date(2027, 1, 3));
    expect(months[0].mk).toBe("2026-09");
    expect(months[5].mk).toBe("2027-02");
  });

  test("история месяца — новые сверху", () => {
    const list = monthVisits(
      [b("2026-11-02", { start_min: 600 }), b("2026-11-09"), b("2026-11-02", { start_min: 900 })],
      "2026-11"
    );
    expect(list.map((x) => [x.day, x.start_min])).toEqual([
      ["2026-11-09", 600],
      ["2026-11-02", 900],
      ["2026-11-02", 600],
    ]);
    expect(monthTitle("2026-11")).toBe("Ноябрь 2026 г.");
  });
});

test.describe("Популярные услуги", () => {
  test("по визитам, затем по деньгам; несколько услуг — каждая по своей цене", () => {
    const list = popularServices([
      b("2026-11-01", { service_id: "pedicure", service_name: "Педикюр", price: 80 }),
      b("2026-11-02", { price: 60 }),
      b("2026-11-03", {
        price: 140,
        services: [
          { id: "manicure", name: "Маникюр", price: 60 },
          { id: "pedicure", name: "Педикюр", price: 80 },
        ],
      }),
      b("2026-11-04", { service_id: "brows", service_name: "Брови", price: 30 }),
    ]);
    expect(list.map((s) => [s.name, s.visits, s.sum])).toEqual([
      ["Педикюр", 2, 160],
      ["Маникюр", 2, 120],
      ["Брови", 1, 30],
    ]);
  });
});

test.describe("клиенты", () => {
  const clients = [
    client(1, "Анна"),
    client(2, "Вера"),
    client(3, "Галя"),
    client(4, "Даша"),
    client(5, "Ева"),
    client(6, "Жанна"),
    client(7, "Зоя"),
    client(8, "Ира"),
  ];
  const bookings = [
    b("2026-11-01", { client_id: 1 }),
    b("2026-11-02", { client_id: 1 }),
    b("2026-11-03", { client_id: 2, price: 300 }),
    b("2026-11-04", { client_id: 3, price: 100 }),
    b("2026-11-05", { client_id: 4 }),
    b("2026-11-06", { client_id: 5 }),
    b("2026-11-07", { client_id: 6 }),
    b("2026-06-01", { client_id: 7 }), // был давно — вне периода
    b("2026-11-20", { client_id: 8, status: "new", start_min: 840 }), // ещё не был, есть заявка
  ];
  const a = analyticsFor({ now: NOW, clients, bookings });

  test("постоянные: до пяти, по визитам, при равенстве — по деньгам", () => {
    expect(a.top.map((t) => t.client.name)).toEqual(["Анна", "Вера", "Галя", "Даша", "Ева"]);
    expect(a.top[0]).toMatchObject({ visits: 2, sum: 200, lastVisit: "2026-11-02" });
  });

  test("редко приходят: не из постоянных, сначала кто не был, затем кто дольше", () => {
    expect(a.rare.map((r) => r.client.name)).toEqual(["Ира", "Зоя", "Жанна"]);
    expect(a.rare[0]).toMatchObject({ visits: 0, lastVisit: null });
    expect(a.rare[0].next).toMatchObject({ day: "2026-11-20", start_min: 840 });
    expect(a.rare[1]).toMatchObject({ visits: 0, lastVisit: "2026-06-01", next: null });
  });
});
