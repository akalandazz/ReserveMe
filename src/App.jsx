import { useCallback, useEffect, useState } from "react";
import "./index.css";
import {
  initContent,
  refreshAll,
  refreshContent,
  useContent,
} from "./content.js";
import { changesToast, refreshMyBookings, resetMyBookings } from "./bookings.js";
import { initAuth, signOut, useSession } from "./supabase.js";
import { init } from "./telegram.js";
import { initTheme } from "./theme.js";
import { BootError, BootLoading } from "./ui.jsx";
import AuthScreen from "./screens/AuthScreen.jsx";
import BookingScreen from "./screens/BookingScreen.jsx";
import ContactScreen from "./screens/ContactScreen.jsx";
import InfoScreen from "./screens/InfoScreen.jsx";
import LocationScreen from "./screens/LocationScreen.jsx";
import MenuScreen from "./screens/MenuScreen.jsx";
import MyBookingsScreen from "./screens/MyBookingsScreen.jsx";
import ServicesScreen from "./screens/ServicesScreen.jsx";
import WaitlistScreen from "./screens/WaitlistScreen.jsx";

const HOME = "menu";
// reschedule — перенос своей записи ({ id, day, time, duration }), null —
// новая заявка. Сбрасывается вместе со всем черновиком (home()) и при
// старте новой записи.
const EMPTY_DRAFT = { service: null, dateKey: null, time: null, comment: "", reschedule: null };
// Период опроса — VITE_CLIENT_POLL_SECONDS (.env.example), по умолчанию 20 с.
const POLL_MS = (Number(import.meta.env.VITE_CLIENT_POLL_SECONDS) || 20) * 1000;

// Шаги записи — элементы того же стека, что и экраны.
// Благодаря этому кнопка «назад» проходит флоу в обратном порядке
// без отдельных обработчиков.
const BOOKING_STEPS = ["book:service", "book:date", "book:time", "book:confirm"];

// Решение мастера (подтвердила, перенесла, отменила) клиент видит
// тостом — другого канала к нему нет: бот ему не пишет, а сообщение в
// чате мастер может и не отправить. setState — только после ответа сервера.
async function syncAndNotify(setToast) {
  const { changes } = await refreshMyBookings();
  if (changes.length > 0) setToast(changesToast(changes));
}

function App() {
  const [stack, setStack] = useState([HOME]);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  // Короткое сообщение на главной после отправки заявки.
  const [toast, setToast] = useState("");
  const screen = stack[stack.length - 1];
  const content = useContent();
  // Мини-апп целиком — только для вошедших (AuthScreen). Записи клиента
  // живут на сервере и привязаны к аккаунту (src/bookings.js).
  const session = useSession();
  const signed = session.status === "signed";

  const sync = useCallback(() => syncAndNotify(setToast), []);

  // Первую синхронизацию записей делает эффект смены экрана ниже —
  // стартовый экран и есть главная.
  useEffect(() => {
    init();
    initTheme();
    initAuth();
    initContent();
  }, []);

  // Клиент всегда видит свежие данные: контент и занятость перечитываются
  // на каждой смене экрана (шаги записи — тоже экраны). Кэш из content.js
  // — только первый кадр. Одновременные вызовы refreshAll() сливаются в
  // один запрос, так что быстрые «назад» базу не заваливают. Статусы
  // своих записей — там, где клиент их видит: главная и «Мои записи»
  // (последняя перечитывает и сама; refreshMyBookings() сливает вызовы).
  // До входа — ничего: записи и заявки открыты только вошедшим.
  useEffect(() => {
    if (!signed) return;
    refreshAll();
    if (screen === HOME || screen === "my") sync();
  }, [screen, sync, signed]);

  // Пока мини-апп открыт и на экране — опрос: мастер правит цены, график и
  // решает по заявкам, пока клиент смотрит на экран. refreshAll() и
  // refreshMyBookings() сами сливают одновременные вызовы, так что медленная
  // сеть запросы не копит. Статусы — только на главной и в «Мои записи»,
  // как выше: тост живёт на главной, а синхронизация посреди записи
  // запомнила бы новый статус как «уже виденный», и тоста клиент бы не увидел.
  useEffect(() => {
    if (!signed) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshAll();
      if (screen === HOME || screen === "my") sync();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [screen, sync, signed]);

  // Мини-апп живёт долго и не перезагружается: клиент свернул Telegram,
  // вернулся через час — а мастер за это время подняла цену, закрыла
  // окошко или подтвердила заявку. Перечитываем на возврате во вкладку.
  useEffect(() => {
    if (!signed) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refreshAll();
      sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sync, signed]);

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

  // 2) Видимость — отдельным эффектом, зависит только от глубины стека
  //    (и от входа: на AuthScreen возвращаться некуда).
  useEffect(() => {
    const bb = window.Telegram?.WebApp?.BackButton;
    if (!bb) return;
    if (signed && stack.length > 1) bb.show();
    else bb.hide();
  }, [stack.length, signed]);

  // 3) Прячем кнопку при размонтировании — мини-апп может переоткрыться.
  useEffect(() => () => window.Telegram?.WebApp?.BackButton?.hide(), []);

  const startBooking = useCallback(
    (service) => {
      if (service) {
        // смена услуги обнуляет время: слот на 90 мин может не существовать для 120
        setDraft((d) => ({ ...d, service, time: null, reschedule: null }));
        push("book:date");
      } else {
        setDraft((d) => ({ ...d, reschedule: null }));
        push("book:service");
      }
    },
    [push]
  );

  // «Перенести» в «Мои записи»: те же шаги, начиная с дня, с той же
  // услугой. Сервер (reschedule_own_booking) сам проверит, что запись своя.
  const startReschedule = useCallback(
    (booking, service) => {
      setDraft({
        ...EMPTY_DRAFT,
        service,
        dateKey: booking.day,
        comment: booking.comment,
        reschedule: {
          id: booking.id,
          day: booking.day,
          time: booking.time,
          duration: booking.duration,
        },
      });
      push("book:date");
    },
    [push]
  );

  // Выход — с главной. Записи — на сервере, за аккаунтом; из стора их
  // убираем, чтобы следующий вошедший не увидел чужие.
  const logout = useCallback(async () => {
    await signOut();
    resetMyBookings();
    home();
  }, [home]);

  if (session.status === "unknown") return <BootLoading />;
  if (!signed) return <AuthScreen session={session} />;

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
          onBack={back}
          onBook={() => {
            home();
            push("book:service");
          }}
          onReschedule={startReschedule}
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
      return (
        <MenuScreen
          onOpen={(id) => (id === "book:service" ? startBooking() : push(id))}
          toast={toast}
          name={session.name}
          onSignOut={logout}
        />
      );
  }
}

export default App;
