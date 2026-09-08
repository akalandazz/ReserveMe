import { useMemo } from "react";
import { dateKey, toHHMM, toMinutes } from "../../schedule.js";
import {
  PX_H,
  bookingsForDay,
  eventGeometry,
  hourLabels,
  hoursFor,
  layoutEvents,
  parseKey,
  weekRange,
  weekStart,
} from "../calendar.js";
import { Icon } from "./Icons.jsx";

const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const D = new Intl.DateTimeFormat("ru-RU", { day: "numeric" });
const DM = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

/** «7 – 13 сент.», но «28 сент. – 4 окт.» на стыке месяцев. */
function rangeLabel(start, end) {
  const left = start.getMonth() === end.getMonth() ? D.format(start) : DM.format(start);
  return `${left} – ${DM.format(end)}`;
}

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

  const keys = useMemo(() => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(dateKey(d));
    }
    return out;
  }, [start]);

  const step = settings?.slotStepMinutes || 30;
  const range = useMemo(
    () => weekRange(settings, keys, bookings, blockedSlots, step),
    [settings, keys, bookings, blockedSlots, step]
  );
  const labels = useMemo(() => hourLabels(range), [range]);
  const trackH = range.hours * PX_H;
  const todayKey = dateKey(new Date());

  const cols = useMemo(
    () =>
      keys.map((key, i) => {
        const dow = (start.getDay() + i) % 7;
        const hours = hoursFor(settings, dow);
        const isClosed = !hours || daysOff.includes(key);

        // Рабочее окно дня — светлая полоса на приглушённом фоне колонки.
        // Закрытый вручную день (days_off) остаётся полностью приглушённым,
        // хотя часы в графике у него есть.
        const open =
          hours && !isClosed
            ? eventGeometry(range, toMinutes(hours.from), toMinutes(hours.to) - toMinutes(hours.from))
            : null;

        const raw = [
          ...bookingsForDay(bookings, key).map((b) => ({
            id: `b${b.id}`,
            start: b.start_min,
            end: b.start_min + (b.duration || step),
            kind: b.status === "new" ? "new" : "ok",
            time: toHHMM(b.start_min),
            title: `${toHHMM(b.start_min)} · ${b.service_name} · ${b.client_name || "клиент"}`,
          })),
          ...blockedSlots
            .filter((b) => b.day === key)
            .map((b) => ({
              id: `x${b.start_min}`,
              start: b.start_min,
              end: b.start_min + step,
              kind: "blocked",
              time: toHHMM(b.start_min),
              title: `${toHHMM(b.start_min)} · закрыто`,
            })),
        ];

        const events = layoutEvents(raw).map((e) => {
          const { top, h } = eventGeometry(range, e.start, e.end - e.start);
          return {
            ...e,
            top,
            h,
            left: `calc(${(e.lane / e.lanes) * 100}% + 2px)`,
            width: `calc(${100 / e.lanes}% - 4px)`,
          };
        });

        return {
          key,
          dow,
          dayNum: parseKey(key).getDate(),
          isClosed,
          isSelected: key === selectedKey,
          isToday: key === todayKey,
          open,
          events,
        };
      }),
    [keys, start, settings, daysOff, bookings, blockedSlots, selectedKey, todayKey, range, step]
  );

  return (
    <div className="week-panel">
      <div className="week-head">
        <button className="round-btn lg" type="button" aria-label="Предыдущая неделя" onClick={() => onShift(-7)}>
          <Icon name="chevronLeft" size={15} />
        </button>
        <span className="week-title">{rangeLabel(start, end)}</span>
        <button className="round-btn lg" type="button" aria-label="Следующая неделя" onClick={() => onShift(7)}>
          <Icon name="chevronRight" size={15} />
        </button>
      </div>

      <div className="week-grid" style={{ "--px-h": `${PX_H}px` }}>
        <div className="week-corner" />
        {cols.map((c) => (
          <button
            type="button"
            key={`h${c.key}`}
            className="week-day-head"
            data-state={c.isSelected ? "selected" : c.isClosed ? "closed" : "open"}
            data-today={c.isToday ? "true" : undefined}
            aria-pressed={c.isSelected ? "true" : "false"}
            onClick={() => onSelect(c.key)}
          >
            <span className="week-day-weekday">{WD_SHORT[c.dow]}</span>
            <span className="week-day-num">{c.dayNum}</span>
          </button>
        ))}

        <div className="week-hours">
          <div className="week-hours-inner" style={{ height: trackH }}>
            {labels.map((h, i) => (
              <span className="week-hour-label" key={h} style={{ top: i * PX_H }}>
                {h}
              </span>
            ))}
          </div>
        </div>

        {cols.map((c) => (
          <div
            className="week-col"
            key={c.key}
            data-state={c.isSelected ? "selected" : c.isClosed ? "closed" : "open"}
            style={{ height: trackH }}
          >
            {c.open && (
              <div className="week-open" style={{ top: c.open.top, height: c.open.h }} />
            )}
            {c.events.map((e) => (
              <button
                type="button"
                key={e.id}
                className="week-event"
                data-kind={e.kind}
                style={{ top: e.top, height: e.h, left: e.left, width: e.width }}
                title={e.title}
                aria-label={e.title}
                onClick={() => onSelect(c.key)}
              >
                {e.kind !== "blocked" && e.h >= 26 && <span className="week-event-time">{e.time}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="week-legend">
        <span className="legend-item">
          <span className="legend-bar" />
          подтверждена
        </span>
        <span className="legend-item">
          <span className="legend-bar is-new" />
          ждёт ответа
        </span>
        <span className="legend-item">
          <span className="legend-bar is-blocked" />
          закрыто
        </span>
      </div>
    </div>
  );
}
