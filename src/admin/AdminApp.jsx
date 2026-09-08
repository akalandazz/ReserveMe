import { useEffect, useMemo, useRef, useState } from "react";
import { dateKey } from "../schedule.js";
import { init } from "../telegram.js";
import { currentTheme, initTheme, subscribeTheme, toggleTheme } from "../theme.js";
import { initAuth, signOut, useSession } from "../supabase.js";
import { isBookingPast, weekStart } from "./calendar.js";
import { loadAdminData, resetAdminData, useAdminData } from "./store.js";
import CalendarSection from "./components/CalendarSection.jsx";
import { Icon } from "./components/Icons.jsx";
import RequestsSection from "./components/RequestsSection.jsx";
import ScheduleSection from "./components/ScheduleSection.jsx";
import ServicesSection from "./components/ServicesSection.jsx";
import SignIn from "./components/SignIn.jsx";
import StatsRow from "./components/StatsRow.jsx";

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
  const toastTimer = useRef(null);
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

  const showToast = (msg) => {
    setToast(msg);
    // Короткий тост, а не постоянный баннер — как в клиентском приложении.
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4000);
  };
  const showError = (msg) => showToast(`⚠️ ${msg}`);

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
      </div>

      {toast && <div className="toast">{toast}</div>}

      <div className="page-body">
        <div className="header-row">
          <h1 className="title">Расписание</h1>
          {data.settings?.masterName && (
            <span className="header-name">{data.settings.masterName}</span>
          )}
        </div>

        {data.status === "error" && (
          <p className="form-error">{data.error}</p>
        )}

        {(data.status === "loading" || data.status === "idle") && !data.settings ? (
          <div className="blank tall">Загрузка…</div>
        ) : (
          <>
            <StatsRow {...stats} />

            <RequestsSection bookings={data.bookings} onToast={showToast} onError={showError} />

            <CalendarSection
              settings={data.settings}
              daysOff={data.daysOff}
              bookings={data.bookings}
              blockedSlots={data.blockedSlots}
              onToast={showToast}
              onError={showError}
            />

            <ServicesSection services={data.services} onToast={showToast} onError={showError} />

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
      </div>
    </div>
  );
}
