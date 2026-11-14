import { expect, test } from "@playwright/test";
import {
  analyticsFor,
  currentMonthRange,
  deltaLabel,
  isUpcoming,
  isVisit,
  monthTitle,
  monthTotals,
  popularServices,
  previousRange,
  rangeLabel,
} from "../../src/admin/analytics.js";

// Аналитика кабинета (src/admin/analytics.js): считаются только
// подтверждённые записи — прошедшие («Заработано») и будущие
// («Ожидается»), по цене на самой записи. Часы — устройства, поэтому
// «сейчас» здесь всегда задано явно, в местном времени.

const NOW = new Date(2026, 10, 14, 12, 0); // 14 ноября 2026, 12:00
const NOV = { from: "2026-11-01", to: "2026-11-30" };

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

test.describe("что считается", () => {
  test("визит — подтверждённая и уже начавшаяся", () => {
    expect(isVisit(b("2026-11-13"), NOW)).toBe(true);
    expect(isVisit(b("2026-11-14", { start_min: 600 }), NOW)).toBe(true);
    expect(isVisit(b("2026-11-14", { start_min: 780 }), NOW)).toBe(false);
  });

  test("впереди — подтверждённая и ещё не начавшаяся", () => {
    expect(isUpcoming(b("2026-11-14", { start_min: 780 }), NOW)).toBe(true);
    expect(isUpcoming(b("2026-11-20"), NOW)).toBe(true);
    expect(isUpcoming(b("2026-11-13"), NOW)).toBe(false);
  });

  test("заявки и отменённые — ни то, ни другое", () => {
    for (const status of ["new", "cancelled"]) {
      expect(isVisit(b("2026-11-13", { status }), NOW)).toBe(false);
      expect(isUpcoming(b("2026-11-20", { status }), NOW)).toBe(false);
    }
  });
});

test.describe("периоды", () => {
  test("по умолчанию — этот календарный месяц целиком", () => {
    expect(currentMonthRange(NOW)).toEqual(NOV);
    expect(currentMonthRange(new Date(2027, 1, 28, 23, 59))).toEqual({
      from: "2027-02-01",
      to: "2027-02-28",
    });
    expect(currentMonthRange(new Date(2026, 11, 31))).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  test("прошлый период: целые месяцы — те же месяцы до, иначе — те же дни", () => {
    expect(previousRange(NOV)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(previousRange({ from: "2026-01-01", to: "2026-03-31" })).toEqual({
      from: "2025-10-01",
      to: "2025-12-31",
    });
    expect(previousRange({ from: "2026-11-10", to: "2026-11-16" })).toEqual({
      from: "2026-11-03",
      to: "2026-11-09",
    });
    expect(previousRange({ from: null, to: null })).toBeNull();
  });

  test("подписи периода", () => {
    expect(rangeLabel(NOV)).toBe("1 – 30 нояб.");
    expect(rangeLabel({ from: "2026-10-05", to: "2026-11-12" })).toBe("5 окт. – 12 нояб.");
    expect(rangeLabel({ from: "2026-11-14", to: "2026-11-14" })).toBe("14 нояб.");
    expect(rangeLabel({ from: "2025-12-20", to: "2026-01-10" })).toMatch(/^20 дек\. 2025 г\. – 10 янв\. 2026 г\.$/);
    expect(rangeLabel({ from: null, to: null })).toBe("всё время");
  });
});

test.describe("Заработано и Ожидается", () => {
  test("обе границы включительно, будущие подтверждённые — в «Ожидается»", () => {
    const a = analyticsFor({
      now: NOW,
      ...NOV,
      clients: [client(1, "Анна")],
      bookings: [
        b("2026-11-01", { price: 50 }), // первый день
        b("2026-11-10", { price: 150 }),
        b("2026-11-14", { start_min: 780, price: 70 }), // сегодня, но позже
        b("2026-11-30", { price: 30 }), // последний день
        b("2026-12-01", { price: 999 }), // уже не в периоде
        b("2026-11-12", { price: 999, status: "new" }),
        b("2026-11-25", { price: 999, status: "new" }),
      ],
    });
    expect(a.earned).toBe(200);
    expect(a.expected).toBe(100);
    expect(a.total).toBe(300);
    expect(a.visitCount).toBe(2);
    expect(a.upcomingCount).toBe(2);
    expect(a.avg).toBe(100);
    expect(a.clientCount).toBe(1);
  });

  test("изменение — итог к итогу такого же прошлого периода", () => {
    const a = analyticsFor({
      now: NOW,
      ...NOV,
      clients: [],
      bookings: [b("2026-10-10", { price: 200 }), b("2026-11-10", { price: 100 }), b("2026-11-20", { price: 200 })],
    });
    expect(a.delta).toBe(50);
    expect(deltaLabel(a.delta)).toBe("+50% к прошлому периоду");
  });

  test("изменение скрыто для «Всё» и при пустом прошлом периоде", () => {
    const bookings = [b("2026-11-10")];
    expect(analyticsFor({ now: NOW, ...NOV, clients: [], bookings }).delta).toBeNull();
    expect(analyticsFor({ now: NOW, clients: [], bookings }).delta).toBeNull();
    expect(deltaLabel(null)).toBe("");
    expect(deltaLabel(-8)).toBe("−8% к прошлому периоду");
  });

  test("без визитов средний чек — null", () => {
    expect(analyticsFor({ now: NOW, ...NOV, clients: [], bookings: [] }).avg).toBeNull();
  });
});

test.describe("по месяцам", () => {
  test("шесть месяцев до текущего; заработано и ожидается отдельно", () => {
    const months = monthTotals(
      [
        b("2026-11-01", { price: 70 }),
        b("2026-11-20", { price: 30 }),
        b("2026-06-30", { price: 40 }),
        b("2026-05-31"),
        b("2026-11-21", { status: "new" }),
      ],
      NOW
    );
    expect(months.map((m) => m.mk)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(months[0]).toMatchObject({ earned: 40, expected: 0 });
    expect(months[5]).toMatchObject({ earned: 70, expected: 30, current: true });
  });

  test("переход через новый год", () => {
    const months = monthTotals([], new Date(2027, 1, 3));
    expect(months[0].mk).toBe("2026-09");
    expect(months[5].mk).toBe("2027-02");
  });

  test("название месяца", () => {
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

  test("будущие записи — не визиты услуги", () => {
    const a = analyticsFor({ now: NOW, ...NOV, clients: [], bookings: [b("2026-11-20")] });
    expect(a.services).toEqual([]);
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
  const a = analyticsFor({ now: NOW, ...NOV, clients, bookings });

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
