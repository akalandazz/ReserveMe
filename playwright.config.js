import { defineConfig, devices } from "@playwright/test";
import { ANON_KEY, SUPABASE_URL } from "./e2e/support/fake-supabase.js";

const PORT = 5179;

// E2E гоняют свой dev-сервер, а не тот, что на 5173: у того Supabase —
// боевой проект из .env. Переменные процесса перекрывают .env (так
// работает loadEnv в Vite), и кабинет стучится в поддельный Supabase
// (e2e/support/fake-supabase.js). Поэтому и reuseExistingServer: false.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "ru-RU",
    timezoneId: "Asia/Tbilisi",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mobile-chromium",
      // PW_CHANNEL=msedge / chrome — установленный браузер вместо скачанного Chromium.
      // trim(): в cmd `set PW_CHANNEL=msedge && …` пробел перед && попадает в значение.
      use: { ...devices["Pixel 7"], channel: process.env.PW_CHANNEL?.trim() || undefined },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/admin.html`,
    reuseExistingServer: false,
    timeout: 120_000,
    // Опрос — ровно 20 с, что бы ни стояло в .env: тесты мотают часы на 20_000.
    env: {
      VITE_SUPABASE_URL: SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: ANON_KEY,
      VITE_CLIENT_POLL_SECONDS: "20",
      VITE_ADMIN_POLL_SECONDS: "20",
    },
  },
});
