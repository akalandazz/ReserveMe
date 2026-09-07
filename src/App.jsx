import { useCallback, useEffect, useState } from "react";
import "./index.css";
import { initContent, refreshContent, useContent } from "./content.js";
import { initAuth } from "./supabase.js";
import { START_PARAM, init } from "./telegram.js";
import { initTheme } from "./theme.js";
import { BootError, BootLoading } from "./ui.jsx";
import AdminScreen from "./screens/AdminScreen.jsx";
import BookingScreen from "./screens/BookingScreen.jsx";
import ContactScreen from "./screens/ContactScreen.jsx";
import InfoScreen from "./screens/InfoScreen.jsx";
import LocationScreen from "./screens/LocationScreen.jsx";
import MenuScreen from "./screens/MenuScreen.jsx";
import MyBookingsScreen from "./screens/MyBookingsScreen.jsx";
import ServicesScreen from "./screens/ServicesScreen.jsx";
import WaitlistScreen from "./screens/WaitlistScreen.jsx";

const HOME = "menu";
const EMPTY_DRAFT = { service: null, dateKey: null, time: null, comment: "" };

// Шаги записи — элементы того же стека, что и экраны.
// Благодаря этому кнопка «назад» проходит флоу в обратном порядке
// без отдельных обработчиков.
const BOOKING_STEPS = ["book:service", "book:date", "book:time", "book:confirm"];

// Разделы админки — по той же причине элементы того же стека.
const ADMIN_STEPS = [
  "admin",
  "admin:services",
  "admin:service",
  "admin:schedule",
  "admin:contact",
  "admin:info",
];

/**
 * Прямая ссылка в админку: ?startapp=admin в Telegram, #admin в браузере.
 * Читается один раз при первом рендере — эффект тут не нужен, а лениво
 * заданное начальное состояние переживает двойной вызов под StrictMode.
 */
function initialStack() {
  const params = new URLSearchParams(window.location.search);

  const wantsAdmin =
    params.get("startapp") === "admin" ||
    window.location.hash === "#admin";

  return wantsAdmin ? [HOME, "admin"] : [HOME];
}

function App() {
  const [stack, setStack] = useState(initialStack);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  // Короткое сообщение на главной после отправки заявки.
  const [toast, setToast] = useState("");
  const screen = stack[stack.length - 1];
  const content = useContent();

  useEffect(() => {
    init();
    initTheme();
    initContent();
    initAuth();
  }, []);

  const push = useCallback((next) => {
    setStack((s) => [...s, next]);
    setToast("");
  }, []);

  // Без зависимостей (через setter-форму) — иначе идентичность меняется
  // каждый рендер и подписка на BackButton дёргается впустую.
  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const home = useCallback((message) => {
    setStack([HOME]);
    setDraft(EMPTY_DRAFT);
    setToast(typeof message === "string" ? message : "");
  }, []);

  // 1) Подписка на клик — ровно один раз за жизнь приложения.
  //    Без offClick Telegram копит обработчики.
  useEffect(() => {
    const bb = window.Telegram?.WebApp?.BackButton;
    if (!bb) return;
    bb.onClick(back);
    return () => bb.offClick(back);
  }, [back]);

  // 2) Видимость — отдельным эффектом, зависит только от глубины стека.
  useEffect(() => {
    const bb = window.Telegram?.WebApp?.BackButton;
    if (!bb) return;
    if (stack.length > 1) bb.show();
    else bb.hide();
  }, [stack.length]);

  // 3) Прячем кнопку при размонтировании — мини-апп может переоткрыться.
  useEffect(() => () => window.Telegram?.WebApp?.BackButton?.hide(), []);

  const startBooking = useCallback(
    (service) => {
      if (service) {
        // смена услуги обнуляет время: слот на 90 мин может не существовать для 120
        setDraft((d) => ({ ...d, service, time: null }));
        push("book:date");
      } else {
        push("book:service");
      }
    },
    [push]
  );

  // Админка доступна всегда, до гейта загрузки: иначе пустая или
  // недоступная база запирает приложение и чинить его будет негде.
  if (ADMIN_STEPS.includes(screen)) {
    return <AdminScreen step={screen} push={push} back={back} home={home} />;
  }

  // Без контента рисовать нечего — даже имя мастера в крошке приходит из базы.
  if (!content.settings) {
    if (content.status === "error") {
      return (
        <BootError
          message={content.error}
          onRetry={refreshContent}
          onAdmin={() => push("admin")}
        />
      );
    }
    return <BootLoading />;
  }

  if (BOOKING_STEPS.includes(screen)) {
    return (
      <BookingScreen
        step={screen}
        draft={draft}
        setDraft={setDraft}
        push={push}
        back={back}
        home={home}
      />
    );
  }

  switch (screen) {
    case "my":
      return (
        <MyBookingsScreen
          onBack={back}
          onBook={() => {
            home();
            push("book:service");
          }}
        />
      );
    case "waitlist":
      return <WaitlistScreen onBack={back} home={home} />;
    case "services":
      return <ServicesScreen onBack={back} onPick={startBooking} />;
    case "location":
      return <LocationScreen onBack={back} />;
    case "contact":
      return <ContactScreen onBack={back} />;
    case "info":
      return <InfoScreen onBack={back} onContact={() => push("contact")} />;
    default:
      return <MenuScreen onOpen={push} toast={toast} />;
  }
}

export default App;
