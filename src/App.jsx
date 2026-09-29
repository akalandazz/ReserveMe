import { useCallback, useEffect, useState } from "react";
import "./index.css";
import {
  initContent,
  refreshAll,
  refreshContent,
  useContent,
} from "./content.js";
import { changesToast, syncBookings } from "./sync.js";
import { init } from "./telegram.js";
import { initTheme } from "./theme.js";
import { BootError, BootLoading } from "./ui.jsx";
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
const POLL_MS = 20_000;

// Шаги записи — элементы того же стека, что и экраны.
// Благодаря этому кнопка «назад» проходит флоу в обратном порядке
// без отдельных обработчиков.
const BOOKING_STEPS = ["book:service", "book:date", "book:time", "book:confirm"];

// Решение мастера (подтвердила, отменила) клиент видит тостом — другого
// канала к нему нет: бот ему не пишет, а сообщение в чате мастер может
// и не отправить. setState — только после ответа сервера.
async function syncAndNotify(setRev, setToast) {
  const { changes } = await syncBookings();
  if (changes.length === 0) return;
  setRev((n) => n + 1);
  setToast(changesToast(changes));
}

function App() {
  const [stack, setStack] = useState([HOME]);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  // Короткое сообщение на главной после отправки заявки.
  const [toast, setToast] = useState("");
  const screen = stack[stack.length - 1];
  const content = useContent();

  // Растёт после каждой синхронизации, поменявшей записи: главная
  // перечитывает по нему хранилище.
  const [bookingsRev, setBookingsRev] = useState(0);

  const sync = useCallback(() => syncAndNotify(setBookingsRev, setToast), []);

  // Первую синхронизацию записей делает эффект смены экрана ниже —
  // стартовый экран и есть главная.
  useEffect(() => {
    init();
    initTheme();
    initContent();
  }, []);

  // Клиент всегда видит свежие данные: контент и занятость перечитываются
  // на каждой смене экрана (шаги записи — тоже экраны). Кэш из content.js
  // — только первый кадр. Одновременные вызовы refreshAll() сливаются в
  // один запрос, так что быстрые «назад» базу не заваливают. Статусы
  // своих записей — там, где клиент их видит: главная и «Мои записи»
  // (последняя синхронизируется и сама, syncBookings() дублей не шлёт).
  useEffect(() => {
    refreshAll();
    if (screen === HOME || screen === "my") sync();
  }, [screen, sync]);

  // Пока мини-апп открыт и на экране — опрос: мастер правит цены, график и
  // решает по заявкам, пока клиент смотрит на экран. refreshAll() и
  // syncBookings() сами сливают одновременные вызовы, так что медленная
  // сеть запросы не копит. Статусы — только на главной и в «Мои записи»,
  // как выше: тост живёт на главной, а синхронизация посреди записи
  // сохранила бы новый статус молча, и тоста клиент бы уже не увидел.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshAll();
      if (screen === HOME || screen === "my") sync();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [screen, sync]);

  // Мини-апп живёт долго и не перезагружается: клиент свернул Telegram,
  // вернулся через час — а мастер за это время подняла цену, закрыла
  // окошко или подтвердила заявку. Перечитываем на возврате во вкладку.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refreshAll();
      sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sync]);

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

  // Без контента рисовать нечего — даже имя мастера в крошке приходит из базы.
  if (!content.settings) {
    if (content.status === "error") {
      return <BootError message={content.error} onRetry={refreshContent} />;
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
          rev={bookingsRev}
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
      return <MenuScreen onOpen={push} toast={toast} rev={bookingsRev} />;
  }
}

export default App;
