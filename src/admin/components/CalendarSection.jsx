import { dateKey } from "../../schedule.js";
import { parseKey } from "../calendar.js";
import DayPanel from "./DayPanel.jsx";
import MonthGrid from "./MonthGrid.jsx";
import WeekGrid from "./WeekGrid.jsx";

const VIEWS = [
  { id: "month", label: "Месяц" },
  { id: "week", label: "Неделя" },
  { id: "day", label: "День" },
];

/**
 * Панель «День» показана всегда, ниже переключателя — Месяц/Неделя
 * лишь добавляют сверху обзор, из которого выбирают дату (как в
 * макете: единственная вещь, что скрывает переключатель «День», —
 * сами обзорные сетки).
 *
 * view/selectedKey приходят от AdminApp, а не живут здесь локально:
 * вкладка «Клиенты» читает тот же selectedKey для режима «За день»,
 * и оба должны пережить переключение вкладок кабинета.
 */
export default function CalendarSection({
  settings,
  daysOff,
  bookings,
  blockedSlots,
  view,
  setView,
  selectedKey,
  setSelectedKey,
  busy,
  busyThen,
  onToast,
  onError,
  onBook,
}) {
  const shiftDay = (delta) => {
    const d = parseKey(selectedKey);
    d.setDate(d.getDate() + delta);
    setSelectedKey(dateKey(d));
  };
  const shiftWeek = (delta) => shiftDay(delta);

  return (
    <div>
      <p className="eyebrow">Календарь</p>
      <div className="view-toggle">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className="view-btn"
            aria-pressed={view === v.id ? "true" : "false"}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === "month" && (
        <MonthGrid
          settings={settings}
          daysOff={daysOff}
          bookings={bookings}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
        />
      )}

      {view === "week" && (
        <WeekGrid
          settings={settings}
          daysOff={daysOff}
          bookings={bookings}
          blockedSlots={blockedSlots}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          onShift={shiftWeek}
        />
      )}

      <DayPanel
        settings={settings}
        daysOff={daysOff}
        bookings={bookings}
        blockedSlots={blockedSlots}
        selectedKey={selectedKey}
        onShift={shiftDay}
        busy={busy}
        busyThen={busyThen}
        onToast={onToast}
        onError={onError}
        onBook={onBook}
      />
    </div>
  );
}
