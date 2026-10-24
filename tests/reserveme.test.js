import { describe, expect, it } from "vitest";
import { TestDriver } from "testdriverai/vitest/hooks";

const BASE_URL = process.env.APP_URL || "https://available-sale-afternoon-stream.trycloudflare.com";

describe("ReserveMe Web Views", () => {
  it("displays the privacy policy page", async (context) => {
    const testdriver = TestDriver(context);

    await testdriver.provision.chrome({ url: `${BASE_URL}/privacy.html` });

    const headingAssert = await testdriver.assert("The heading Политика обработки персональных данных is visible");
    expect(headingAssert).toBeTruthy();

    await testdriver.scroll("down", { amount: 500 });

    const operatorAssert = await testdriver.assert("The section Об исполнителе is visible");
    expect(operatorAssert).toBeTruthy();
  });

  it("displays Telegram gate screen when accessing client app in browser", async (context) => {
    const testdriver = TestDriver(context);

    await testdriver.provision.chrome({ url: `${BASE_URL}/` });

    const clientGateAssert = await testdriver.assert("The heading Откройте в Telegram is visible");
    expect(clientGateAssert).toBeTruthy();
  });

  it("displays master cabinet gate screen when accessing admin app in browser", async (context) => {
    const testdriver = TestDriver(context);

    await testdriver.provision.chrome({ url: `${BASE_URL}/admin.html` });

    const adminGateAssert = await testdriver.assert("The heading Кабинет мастера is visible with message that it opens only in Telegram");
    expect(adminGateAssert).toBeTruthy();
  });
});
