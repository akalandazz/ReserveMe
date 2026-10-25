import { expect, test } from "@playwright/test";
import {
  parseSalonBots,
  signInTokens,
  stringifySalonBots,
} from "../../supabase/functions/_shared/salon-bots.js";

// Секрет SALON_BOTS (supabase/functions/_shared/salon-bots.js): токены ботов
// салонов — JSON по slug. Кривая запись выпадает одна, тот же бот у двух
// салонов — выпадают оба, токены в ошибки не попадают.

const A_CLIENT = "111:client-a";
const A_CABINET = "222:cabinet-a";
const B_CLIENT = "333:client-b";

const parse = (obj) => parseSalonBots(JSON.stringify(obj));

test("салоны по slug: клиент, кабинет, секрет вебхука", () => {
  const { bots, errors } = parse({
    main: { client: A_CLIENT, cabinet: A_CABINET, webhook_secret: "hook_A-1" },
    anna: { client: B_CLIENT },
  });
  expect(errors).toEqual([]);
  expect(bots.get("main")).toEqual({ client: A_CLIENT, cabinet: A_CABINET, webhookSecret: "hook_A-1" });
  expect(bots.get("anna")).toEqual({ client: B_CLIENT, cabinet: "", webhookSecret: "" });
  expect(signInTokens(bots.get("main"))).toEqual([A_CLIENT, A_CABINET]);
  expect(signInTokens(bots.get("anna"))).toEqual([B_CLIENT]);
  expect(signInTokens(undefined)).toEqual([]);
});

test("кабинет — тот же бот, что клиент: один токен", () => {
  const { bots, errors } = parse({ main: { client: A_CLIENT, cabinet: A_CLIENT } });
  expect(errors).toEqual([]);
  expect(signInTokens(bots.get("main"))).toEqual([A_CLIENT]);
});

test("секрет не задан — пусто, без ошибок", () => {
  for (const raw of ["", "  ", undefined, null]) {
    const { bots, errors } = parseSalonBots(raw);
    expect(bots.size).toBe(0);
    expect(errors).toEqual([]);
  }
});

test("не JSON или не объект — пусто и ошибка", () => {
  for (const raw of ["{main:", "[]", '"main"', "42"]) {
    const { bots, errors } = parseSalonBots(raw);
    expect(bots.size, raw).toBe(0);
    expect(errors, raw).toHaveLength(1);
  }
});

test("кривая запись выпадает одна, остальные работают", () => {
  const { bots, errors } = parse({
    main: { client: A_CLIENT },
    "BAD SLUG": { client: B_CLIENT },
    nope: "333:x",
    "no-client": {},
    "bad-token": { client: "not a token" },
    "bad-cabinet": { client: "444:ok", cabinet: "nope" },
    "bad-secret": { client: "555:ok", webhook_secret: "has space" },
    "long-secret": { client: "666:ok", webhook_secret: "x".repeat(257) },
    typo: { client: "777:ok", webhookSecret: "abc" },
  });
  expect([...bots.keys()]).toEqual(["main"]);
  expect(errors).toHaveLength(8);
  expect(errors).toContain("запись №2: ключ — slug салона (a–z 0–9 -, 2–32 символа)");
  expect(errors.find((e) => e.startsWith("«typo»"))).toContain("webhookSecret");
});

test("тот же бот у двух салонов — выпадают оба", () => {
  const { bots, errors } = parse({
    main: { client: A_CLIENT, cabinet: A_CABINET },
    anna: { client: B_CLIENT, cabinet: A_CABINET },
    olga: { client: "888:olga" },
  });
  expect([...bots.keys()]).toEqual(["olga"]);
  expect(errors).toEqual([
    "«anna»: тот же бот, что у «main» — у каждого салона свой",
    "«main»: тот же бот, что у «anna» — у каждого салона свой",
  ]);
});

test("в ошибках нет ни токенов, ни секретов", () => {
  const leaky = "999:SUPER-SECRET-token";
  const { errors } = parse({
    [leaky]: { client: leaky },
    one: { client: leaky, webhook_secret: "secret with spaces" },
    two: { client: leaky, cabinet: "bad cabinet secret" },
    three: { client: "123:ok", cabinet: leaky },
    four: { client: leaky },
  });
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) {
    expect(e).not.toContain("SUPER-SECRET");
    expect(e).not.toContain("secret with spaces");
    expect(e).not.toContain("bad cabinet secret");
  }
});

test("stringifySalonBots → parseSalonBots — то же самое, пустых полей нет", () => {
  const { bots } = parse({
    main: { client: A_CLIENT, cabinet: A_CABINET, webhook_secret: "s1" },
    anna: { client: B_CLIENT },
  });
  const json = stringifySalonBots(bots);
  expect(JSON.parse(json)).toEqual({
    anna: { client: B_CLIENT },
    main: { client: A_CLIENT, cabinet: A_CABINET, webhook_secret: "s1" },
  });
  expect(parseSalonBots(json)).toEqual({ bots, errors: [] });
});
