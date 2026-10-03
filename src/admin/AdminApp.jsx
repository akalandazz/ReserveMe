import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dateKey } from "../schedule.js";
import { init } from "../telegram.js";
import { currentTheme, initTheme, subscribeTheme, toggleTheme } from "../theme.js";
import { initAuth, retryRole, signOut, useSession } from "../supabase.js";
import { canMessageClient, cancelBooking, clientSeesStatus } from "./api.js";
import { isBookingPast, weekStart } from "./calendar.js";
import { dropKind, notifyClient } from "./messages.js";
import { loadAdminData, pollAdminData, resetAdminData, useAdminData } from "./store.js";
import BottomNav from "./components/BottomNav.jsx";
import CalendarSection from "./components/CalendarSection.jsx";
import ClientsSection from "./components/ClientsSection.jsx";
import BookingSheet from "./components/BookingSheet.jsx";
import { Icon } from "./components/Icons.jsx";
import RequestsSection from "./components/RequestsSection.jsx";
import ScheduleSection from "./components/ScheduleSection.jsx";
import ServicesSection from "./components/ServicesSection.jsx";
import SignIn from "./components/SignIn.jsx";
import StatsRow from "./components/StatsRow.jsx";

const TAB_TITLES = {
  schedule: "Расписание",
  requests: "Заявки",
  clients: "Клиенты",
  settings: "Настройки",
};

function ThemeToggle() {
  const theme = useSyncTheme();
  return (
    <button
      className="icon-btn is-theme"
      type="button"
      onClick={toggleTheme}
      aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
    >
      <Icon name="moon" size={17} />
    </button>
  );
}

// Крохотная обёртка вместо прямого useSyncExternalStore в JSX —
// незачем тянуть react импорт useSyncExternalStore в двух местах.
function useSyncTheme() {
  const [, force] = useState(0);
  useEffect(() => subscribeTheme(() => force((n) => n + 1)), []);
  return currentTheme();
}

export default function AdminApp() {
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(null);
  const [tab, setTab] = useState("schedule");
  // Живут здесь, а не в CalendarSection: вкладка «Клиенты» читает тот же
  // selectedKey для режима «За день», и оба должны пережить переключение
  // вкладок кабинета.
  const [calView, setCalView] = useState("month");
  const [selectedKey, setSelectedKey] = useState(() => dateKey(new Date()));
  // Лист записи: null — закрыт, иначе { kind: "new" | "edit" | "client", … }
  // (см. BookingSheet.jsx).
  const [sheet, setSheet] = useState(null);
  // Клиент, которого «Клиенты» должны раскрыть — только что заведённый.
  // Объект, а не id: повторное добавление того же id — новая ссылка.
  const [clientFocus, setClientFocus] = useState(null);
  // Открытое подтверждение удаления — одно на весь кабинет:
  // { kind: "booking" | "client", id } или null. Открыть второе —
  // значит закрыть первое, где бы оно ни стояло.
  const [confirmDel, setConfirmDel] = useState(null);
  const toastTimer = useRef(null);
  const busyTimer = useRef(null);
  const session = useSession();
  // Войти теперь может и клиент мини-аппа (роль 'user'). Данные кабинета
  // ему RLS всё равно не отдаст, но и грузить их незачем — а экран
  // должен сказать «это не аккаунт мастера», а не показать пустоту.
  const isMaster = session.status === "signed" && session.role === "master";
  const data = useAdminData();

  useEffect(() => {
    init();
    initTheme();
    initAuth();
  }, []);

  useEffect(() => {
    if (isMaster) loadAdminData();
    else if (session.status !== "signed" && session.status !== "unknown") resetAdminData();
  }, [isMaster, session.status]);

  // Кабинет открыт часами, а заявки и отмены клиентов приходят сами по
  // себе. Пока кабинет на экране, записи опрашиваются (pollAdminData), а
  // на возврате во вкладку перечитываются сразу, не дожидаясь тика, —
  // иначе новая заявка или отмена видна только после перезапуска.
  useEffect(() => {
    if (!isMaster) return;
    const stopPoll = pollAdminData();
    const onVisible = () => {
      if (document.visibilityState === "visible") loadAdminData(["bookings", "clients"]);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopPoll();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isMaster]);

  useEffect(
    () => () => {
      window.clearTimeout(toastTimer.current);
      window.clearTimeout(busyTimer.current);
    },
    []
  );

  const flash = (msg) => {
    setToast(msg);
    // Короткий тост, а не постоянный баннер — как в клиентском приложении.
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3400);
  };
  const showError = (msg) => flash(`⚠️ ${msg}`);

  const openBooking = (clientId) => setSheet({ kind: "new", clientId });
  const editBooking = (bookingId) => setSheet({ kind: "edit", bookingId });
  const editClient = (clientId) => setSheet({ kind: "client", clientId });
  // Стабильная ссылка: BookingSheet подписывается на Escape по ней.
  const closeBooking = useCallback(() => setSheet(null), []);
  // Лист сохранил: тост, и — если он так сказал — показать день записи
  // или раскрыть нового клиента.
  const onSheetDone = ({ toast, day, view, clientId }) => {
    setSheet(null);
    flash(toast);
    if (day) setSelectedKey(day);
    if (view) {
      setTab("schedule");
      setCalView(view);
    }
    if (clientId != null) setClientFocus({ id: clientId });
  };

  // Единое «занято» состояние на весь экран кабинета: пока один запрос
  // выполняется, второй такой же клик — no-op, а не гонка из двух мутаций.
  const busyThen = (key, ms, fn) => {
    if (busy) return;
    setBusy(key);
    busyTimer.current = window.setTimeout(() => {
      setBusy(null);
      fn();
    }, ms);
  };

  const switchTab = (next) => {
    setTab(next);
    setConfirmDel(null);
  };

  // Лист модальный, так что открытым над удаляемым он быть не должен, —
  // но если всё же открыт на удалённом, ему больше нечего сохранять.
  const closeSheetIf = (pred) => setSheet((s) => (s && pred(s) ? null : s));

  // Корзина в панели дня и в «Прошлых записях». Запись из мини-аппа не
  // удаляется, а отменяется (cancelBooking в api.js) — клиент увидит
  // «Отменена мастером» в «Мои записи», а если у него есть логин, ему
  // ещё и откроется чат с сообщением (notifyClient — после записи в
  // базу). Остальные удаляются насовсем.
  const removeBooking = (id) =>
    busyThen(`del-booking-${id}`, 250, async () => {
      const booking = data.bookings.find((b) => b.id === id) ?? { id };
      const res = await cancelBooking(booking);
      if (!res.ok) {
        showError(res.error);
        return;
      }
      setConfirmDel(null);
      closeSheetIf((s) => s.kind === "edit" && s.bookingId === id);
      // О прошедшей записи сообщать незачем.
      const told =
        canMessageClient(booking) &&
        !isBookingPast(booking) &&
        notifyClient(booking, dropKind(booking), data.settings?.masterName);
      flash(
        told
          ? "Запись отменена — открываем чат с клиентом."
          : clientSeesStatus(booking)
            ? "Запись отменена — клиент увидит это в «Мои записи»."
            : "Запись удалена."
      );
    });

  // Клиент удалён (ClientsSection): закрыть лист, если он был о нём или
  // об одной из его записей, и забыть «раскрыть этого клиента».
  const forgetClient = (clientId, bookingIds) => {
    setConfirmDel(null);
    closeSheetIf(
      (s) =>
        s.clientId === clientId || (s.kind === "edit" && bookingIds.includes(s.bookingId))
    );
    setClientFocus((f) => (f?.id === clientId ? null : f));
  };

  const stats = useMemo(() => {
    const todayKey = dateKey(new Date());
    const weekFrom = weekStart(todayKey);
    const weekTo = new Date(weekFrom);
    weekTo.setDate(weekFrom.getDate() + 6);
    const weekFromKey = dateKey(weekFrom);
    const weekToKey = dateKey(weekTo);

    const pendingCount = data.bookings.filter(
      (b) => b.status === "new" && !isBookingPast(b)
    ).length;
    const todayCount = data.bookings.filter((b) => b.day === todayKey).length;
    const weekCount = data.bookings.filter(
      (b) => b.day >= weekFromKey && b.day <= weekToKey
    ).length;
    return { pendingCount, todayCount, weekCount };
  }, [data.bookings]);

  if (session.status === "unknown" || (session.status === "signed" && session.role === null)) {
    return (
      <div className="shell">
        <div className="topbar">
          <span className="crumb">Кабинет мастера</span>
          <ThemeToggle />
        </div>
        <div className="page-body">
          <div className="blank tall">Загрузка…</div>
        </div>
      </div>
    );
  }

  if (session.status !== "signed") {
    return (
      <div className="shell">
        <div className="topbar">
          <span className="crumb">Кабинет мастера</span>
          <ThemeToggle />
        </div>
        <div className="page-body">
          <SignIn session={session} />
        </div>
      </div>
    );
  }

  if (!isMaster) {
    const failed = session.role === "error";
    return (
      <div className="shell">
        <div className="topbar">
          <span className="crumb">Кабинет мастера</span>
          <ThemeToggle />
        </div>
        <div className="page-body">
          <div className="signin-wrap">
            <h1 className="title">{failed ? "Нет связи" : "Нет доступа"}</h1>
            <p className="sub">
              {failed
                ? "Не удалось проверить доступ к кабинету. Проверьте соединение."
                : `${session.name ?? "Этот аккаунт Telegram"} — не аккаунт мастера. Кабинет открыт только мастеру.`}
            </p>
            {failed && (
              <button className="btn-primary inline" type="button" onClick={retryRole}>
                Повторить
              </button>
            )}
            <button
              className={failed ? "btn-text" : "btn-primary inline"}
              type="button"
              onClick={signOut}
            >
              Выйти
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="topbar">
        <span className="crumb">Кабинет мастера</span>
        <ThemeToggle />
        {busy && (
          <div className="progress-bar" aria-hidden="true">
            <div className="progress-fill" />
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}

      <div className="page-body">
        {tab !== "clients" && (
          <div className="header-row">
            <h1 className="title">{TAB_TITLES[tab]}</h1>
            {tab === "schedule" && data.settings && (
              <button className="pill-btn is-accent" type="button" onClick={() => openBooking()}>
                <Icon name="plus" size={14} />
                Записать
              </button>
            )}
            {tab === "settings" && data.settings?.masterName && (
              <span className="header-name">{data.settings.masterName}</span>
            )}
          </div>
        )}

        {data.status === "error" && (
          <p className="form-error">{data.error}</p>
        )}

        {(data.status === "loading" || data.status === "idle") && !data.settings ? (
          <div className="blank tall">Загрузка…</div>
        ) : (
          <>
            {tab === "schedule" && (
              <>
                <StatsRow {...stats} />
                <CalendarSection
                  settings={data.settings}
                  daysOff={data.daysOff}
                  bookings={data.bookings}
                  blockedSlots={data.blockedSlots}
                  view={calView}
                  setView={setCalView}
                  selectedKey={selectedKey}
                  setSelectedKey={setSelectedKey}
                  onToast={flash}
                  onError={showError}
                  onEditBooking={editBooking}
                  busy={busy}
                  confirmDel={confirmDel}
                  setConfirmDel={setConfirmDel}
                  onDeleteBooking={removeBooking}
                />
              </>
            )}

            {tab === "requests" && (
              <RequestsSection
                bookings={data.bookings}
                cancellations={data.cancellations}
                masterName={data.settings?.masterName}
                busy={busy}
                busyThen={busyThen}
                onToast={flash}
                onError={showError}
                onEdit={editBooking}
              />
            )}

            {tab === "clients" && (
              <ClientsSection
                clients={data.clients}
                comments={data.comments}
                bookings={data.bookings}
                selectedKey={selectedKey}
                focus={clientFocus}
                busy={busy}
                busyThen={busyThen}
                onToast={flash}
                onError={showError}
                onBook={openBooking}
                onEditBooking={editBooking}
                onEditClient={editClient}
                confirmDel={confirmDel}
                setConfirmDel={setConfirmDel}
                onDeleteBooking={removeBooking}
                onClientDeleted={forgetClient}
              />
            )}

            {tab === "settings" && (
              <>
                <ServicesSection
                  services={data.services}
                  busy={busy}
                  busyThen={busyThen}
                  onToast={flash}
                  onError={showError}
                />

                <ScheduleSection settings={data.settings} onError={showError} />

                {/* Кто вошёл — рядом с «Выйти»: аккаунт, а не имя мастера из
                    settings (то — контент салона, его видят клиенты). */}
                {session.name && (
                  <div className="account">
                    <span className="eyebrow">Аккаунт</span>
                    <span className="account-email">{session.name}</span>
                  </div>
                )}

                <button
                  className="btn-text danger signout"
                  type="button"
                  onClick={async () => {
                    await signOut();
                  }}
                >
                  Выйти
                </button>
              </>
            )}
          </>
        )}
      </div>

      <BottomNav
        active={tab}
        onChange={switchTab}
        pendingCount={stats.pendingCount + data.cancellations.length}
      />

      {sheet && (
        <BookingSheet
          clients={data.clients}
          services={data.services}
          bookings={data.bookings}
          settings={data.settings}
          daysOff={data.daysOff}
          initial={sheet}
          onClose={closeBooking}
          onDone={onSheetDone}
        />
      )}
    </div>
  );
}
