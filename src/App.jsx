import { useCallback, useEffect, useState } from "react";
import "./index.css";
import { init } from "./telegram.js";
import { initTheme } from "./theme.js";
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

function App() {
  const [stack, setStack] = useState([HOME]);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  // Короткое сообщение на главной после отправки заявки.
  const [toast, setToast] = useState("");
  const screen = stack[stack.length - 1];

  useEffect(() => {
    init();
    initTheme();
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
