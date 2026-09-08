import { useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import { ru } from "react-day-picker/locale";
import { dateKey } from "../../schedule.js";
import { bookingCountsByDay, hoursFor, parseKey } from "../calendar.js";
import { Icon } from "./Icons.jsx";

// Своя тема вместо react-day-picker/style.css: без чужого CSS все
// названия из classNames ниже — обычные пустые крючки, весь вид даёт
// src/admin/admin.css, а не библиотека.
const classNames = {
  root: "rdp",
  months: "rdp-months",
  month: "rdp-month",
  month_caption: "rdp-caption",
  caption_label: "rdp-caption-label",
  month_grid: "rdp-grid",
  weekdays: "rdp-weekdays",
  weekday: "rdp-weekday",
  weeks: "rdp-weeks",
  week: "rdp-week",
  day: "rdp-day",
  day_button: "rdp-day-btn",
};

/**
 * Число + полоска-индикатор количества записей, как в макете.
 * `className` вынут из `rest` намеренно: DayPicker передаёт сюда своё
 * `rdp-day-btn`, и если оставить его в спреде, оно затрёт все классы
 * состояния (is-selected и прочие) — их бы просто не было видно.
 */
function DayButton({ day, modifiers, className, ...rest }) {
  const cls = [className || "rdp-day-btn"];
  if (modifiers.selected) cls.push("is-selected");
  if (modifiers.today) cls.push("is-today");
  if (modifiers.closed) cls.push("is-closed");
  if (modifiers.outside) cls.push("is-outside");
  const count = modifiers.count3 ? 3 : modifiers.count2 ? 2 : modifiers.count1 ? 1 : 0;
  const dotW = count ? Math.min(count, 3) * 6 : 6;
  return (
    <button type="button" className={cls.join(" ")} {...rest}>
      <span className="rdp-day-num">{day.date.getDate()}</span>
      <span
        className="rdp-day-dot"
        style={{ width: dotW, background: count ? undefined : "transparent" }}
      />
    </button>
  );
}

function MonthNav({ month, onPrev, onNext }) {
  const title = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(month);
  const cap = title.charAt(0).toUpperCase() + title.slice(1);
  return (
    <div className="month-head">
      <button className="round-btn lg" type="button" aria-label="Предыдущий месяц" onClick={onPrev}>
        <Icon name="chevronLeft" size={15} />
      </button>
      <span className="month-title">{cap}</span>
      <button className="round-btn lg" type="button" aria-label="Следующий месяц" onClick={onNext}>
        <Icon name="chevronRight" size={15} />
      </button>
    </div>
  );
}

export default function MonthGrid({ settings, daysOff, bookings, selectedKey, onSelect }) {
  const [month, setMonth] = useState(() => parseKey(selectedKey));
  const counts = useMemo(() => bookingCountsByDay(bookings), [bookings]);
  const daysOffSet = useMemo(() => new Set(daysOff), [daysOff]);

  const closed = (date) => {
    const key = dateKey(date);
    return !hoursFor(settings, date.getDay()) || daysOffSet.has(key);
  };
  const count1 = (date) => counts.get(dateKey(date)) === 1;
  const count2 = (date) => counts.get(dateKey(date)) === 2;
  const count3 = (date) => (counts.get(dateKey(date)) || 0) >= 3;

  return (
    <div className="month-panel">
      <MonthNav
        month={month}
        onPrev={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
        onNext={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
      />
      <DayPicker
        mode="single"
        locale={ru}
        month={month}
        onMonthChange={setMonth}
        hideNavigation
        showOutsideDays
        selected={parseKey(selectedKey)}
        onSelect={(d) => {
          if (!d) return;
          onSelect(dateKey(d));
          // клик по дню-«хвосту» соседнего месяца перелистывает сетку —
          // иначе выбранное число осталось бы за пределами показанного месяца.
          setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
        }}
        classNames={classNames}
        components={{ DayButton }}
        modifiers={{ closed, count1, count2, count3 }}
      />
      <div className="month-legend">
        <span className="legend-item">
          <span className="legend-dot" />
          есть записи
        </span>
        <span className="legend-item">
          <span className="legend-box" />
          выходной / закрыт
        </span>
      </div>
    </div>
  );
}
