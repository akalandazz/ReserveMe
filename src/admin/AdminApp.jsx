import { useEffect, useMemo, useRef, useState } from "react";
import { dateKey } from "../schedule.js";
import { init } from "../telegram.js";
import { currentTheme, initTheme, subscribeTheme, toggleTheme } from "../theme.js";
import { initAuth, signOut, useSession } from "../supabase.js";
import { isBookingPast, weekStart } from "./calendar.js";
import { loadAdminData, resetAdminData, useAdminData } from "./store.js";
import BottomNav from "./components/BottomNav.jsx";
import CalendarSection from "./components/CalendarSection.jsx";
import ClientsSection from "./components/ClientsSection.jsx";
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
  const toastTimer = useRef(null);
  const busyTimer = useRef(null);
  const session = useSession();
  const data = useAdminData();

  useEffect(() => {
    init();
    initTheme();
    initAuth();
  }, []);

  useEffect(() => {
    if (session.status === "signed") loadAdminData();
    else if (session.status === "guest") resetAdminData();
  }, [session.status]);

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

  if (session.status === "unknown") {
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
          <SignIn />
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
            {tab === "schedule" && data.settings?.masterName && (
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
                  busy={busy}
                  busyThen={busyThen}
                  onToast={flash}
                  onError={showError}
                />
              </>
            )}

            {tab === "requests" && (
              <RequestsSection
                bookings={data.bookings}
                busy={busy}
                busyThen={busyThen}
                onToast={flash}
                onError={showError}
              />
            )}

            {tab === "clients" && (
              <ClientsSection
                clients={data.clients}
                bookings={data.bookings}
                selectedKey={selectedKey}
                busy={busy}
                busyThen={busyThen}
                onToast={flash}
                onError={showError}
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

      <BottomNav active={tab} onChange={setTab} pendingCount={stats.pendingCount} />
    </div>
  );
}
