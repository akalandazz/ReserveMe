import { useMemo } from "react";
import { dateKey } from "../../schedule.js";
import {
  GRID_HOURS,
  bookingsForDay,
  eventGeometry,
  hourLabels,
  hoursFor,
  weekStart,
} from "../calendar.js";
import { Icon } from "./Icons.jsx";

const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const DM = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

export default function WeekGrid({
  settings,
  daysOff,
  bookings,
  blockedSlots,
  selectedKey,
  onSelect,
  onShift,
}) {
  const start = useMemo(() => weekStart(selectedKey), [selectedKey]);
  const end = useMemo(() => {
    const d = new Date(start);
    d.setDate(d.getDate() + 6);
    return d;
  }, [start]);

  const cols = useMemo(() => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = dateKey(d);
      const dow = d.getDay();
      const hours = hoursFor(settings, dow);
      const isClosed = !hours || daysOff.includes(key);
      const isSelected = key === selectedKey;
      const dayBookings = bookingsForDay(bookings, key);
      const events = dayBookings.map((b) => {
        const { top, h } = eventGeometry(b.start_min, b.duration);
        return {
          id: b.id,
          top,
          h,
          label: `${String(Math.floor(b.start_min / 60)).padStart(2, "0")}:${String(
            b.start_min % 60
          ).padStart(2, "0")} ${b.client_name || b.service_name}`,
          isNew: b.status === "new",
        };
      });
      blockedSlots
        .filter((b) => b.day === key)
        .forEach((b) => {
          const { top } = eventGeometry(b.start_min, 15);
          events.push({ id: `x${b.start_min}`, top, h: 15, label: "×", blocked: true });
        });
      out.push({ key, dow, dayNum: d.getDate(), isClosed, isSelected, events });
    }
    return out;
  }, [start, settings, daysOff, bookings, blockedSlots, selectedKey]);

  return (
    <div className="week-panel">
      <div className="week-head">
        <button className="round-btn" type="button" aria-label="Предыдущая неделя" onClick={() => onShift(-7)}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="week-title">
          {DM.format(start)} – {DM.format(end)}
        </span>
        <button className="round-btn" type="button" aria-label="Следующая неделя" onClick={() => onShift(7)}>
          <Icon name="chevronRight" size={14} />
        </button>
      </div>

      <div className="week-scroll">
        <div className="week-hours-col">
          {hourLabels().map((h) => (
            <div className="week-hour-label" key={h}>
              {h}
            </div>
          ))}
        </div>
        {cols.map((c) => (
          <div className="week-day-col" key={c.key}>
            <button
              type="button"
              className="week-day-head"
              data-state={c.isSelected ? "selected" : c.isClosed ? "closed" : "open"}
              onClick={() => onSelect(c.key)}
            >
              <span className="week-day-weekday">{WD_SHORT[c.dow]}</span>
              <span className="week-day-num">{c.dayNum}</span>
            </button>
            <div
              className="week-track"
              data-state={c.isClosed ? "closed" : "open"}
              style={{ height: GRID_HOURS * 34 }}
            >
              {c.events.map((e) => (
                <div
                  className={e.blocked ? "week-event is-blocked" : e.isNew ? "week-event is-new" : "week-event"}
                  key={e.id}
                  style={{ top: e.top, height: e.h }}
                >
                  {e.label}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
