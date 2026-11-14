import { describe, expect, it } from "vitest";
import { TestDriver } from "testdriverai/vitest/hooks";
import {
  analyticsFor,
  bookingStart,
  deltaLabel,
  isVisit,
  monthTitle,
  monthTotals,
  monthVisits,
  periodRange,
  popularServices,
  sumPrice,
} from "../src/admin/analytics.js";
import { contactLink, monogram } from "../src/admin/contact.js";
import { formatAmount } from "../src/money.js";

const NOW = new Date(2026, 10, 14, 12, 0); // 14 Nov 2026, 12:00

let idCounter = 1;
function makeBooking(day, fields = {}) {
  return {
    id: idCounter++,
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

const makeClient = (id, name, extra = {}) => ({ id, name, ...extra });

describe("Cabinet Analytics & UI", () => {
  it("computes analytics metrics, periods, services, and client rankings accurately", async () => {
    // 1. isVisit checks
    expect(isVisit(makeBooking("2026-11-13"), NOW)).toBe(true);
    expect(isVisit(makeBooking("2026-11-13", { status: "new" }), NOW)).toBe(false);
    expect(isVisit(makeBooking("2026-11-13", { status: "cancelled" }), NOW)).toBe(false);
    expect(isVisit(makeBooking("2026-11-15"), NOW)).toBe(false);
    expect(isVisit(makeBooking("2026-11-14", { start_min: 600 }), NOW)).toBe(true);
    expect(isVisit(makeBooking("2026-11-14", { start_min: 780 }), NOW)).toBe(false);

    // 2. periodRange
    const mRange = periodRange("m", NOW);
    expect(mRange).toEqual({
      from: "2026-10-16",
      to: "2026-11-14",
      prev: { from: "2026-09-16", to: "2026-10-15" },
    });
    const allRange = periodRange("all", NOW);
    expect(allRange).toEqual({ from: null, to: "2026-11-14", prev: null });

    // 3. formatAmount and deltaLabel
    expect(formatAmount(2500)).toMatch(/2\s500/);
    expect(formatAmount(null)).toBe("");
    expect(formatAmount("")).toBe("");
    expect(deltaLabel(15)).toBe("+15% к прошлому периоду");
    expect(deltaLabel(-10)).toBe("−10% к прошлому периоду");
    expect(deltaLabel(null)).toBe("");

    // 4. contactLink and monogram
    expect(monogram("Елена")).toBe("Е");
    expect(monogram("")).toBe("?");
    expect(contactLink({ telegram_username: "elena_tg" })).toEqual({
      href: "https://t.me/elena_tg",
      label: "Написать в Telegram",
      icon: "telegram",
    });
    expect(contactLink({ phone: "+995 555 11 22 33", channel: "wa" })).toEqual({
      href: "https://wa.me/995555112233",
      label: "Написать в WhatsApp",
      icon: "chat",
    });
    expect(contactLink({ phone: "+995 555 11 22 33" })).toEqual({
      href: "tel:+995555112233",
      label: "Позвонить",
      icon: "phone",
    });
    expect(contactLink({})).toBeNull();

    // 5. popularServices with single and multiple services
    const servicesList = popularServices([
      makeBooking("2026-11-01", { service_id: "pedicure", service_name: "Педикюр", price: 80 }),
      makeBooking("2026-11-02", { price: 60 }),
      makeBooking("2026-11-03", {
        price: 140,
        services: [
          { id: "manicure", name: "Маникюр", price: 60 },
          { id: "pedicure", name: "Педикюр", price: 80 },
        ],
      }),
    ]);
    expect(servicesList.map((s) => [s.name, s.visits, s.sum])).toEqual([
      ["Педикюр", 2, 160],
      ["Маникюр", 2, 120],
    ]);

    // 6. analyticsFor comprehensive check
    const clients = [
      makeClient(1, "Анна"),
      makeClient(2, "Вера"),
      makeClient(3, "Галя"),
    ];
    const bookings = [
      makeBooking("2026-11-10", { client_id: 1, price: 150 }),
      makeBooking("2026-10-16", { client_id: 1, price: 50 }),
      makeBooking("2026-10-15", { client_id: 1, price: 100 }), // prev period
      makeBooking("2026-11-20", { client_id: 2, status: "new", start_min: 840 }), // future request
    ];
    const a = analyticsFor({ bookings, clients, period: "m", now: NOW });
    expect(a.revenue).toBe(200);
    expect(a.visitCount).toBe(2);
    expect(a.avg).toBe(100);
    expect(a.clientCount).toBe(1);
    expect(a.delta).toBe(100);
    expect(a.top[0].client.name).toBe("Анна");
    expect(a.rare[0].client.name).toBe("Вера");
    expect(a.rare[0].next).toMatchObject({ day: "2026-11-20", start_min: 840 });
  });

  it("verifies the cabinet web UI in Chrome sandbox", async (context) => {
    const testdriver = TestDriver(context);

    await testdriver.provision.chrome({
      url: "https://beauty-christmas-stamp-audience.trycloudflare.com/admin.html",
    });

    const assertResult = await testdriver.assert(
      "the page displays 'Кабинет мастера' and the 'Повторить' button"
    );
    expect(assertResult).toBeTruthy();
  });
});
