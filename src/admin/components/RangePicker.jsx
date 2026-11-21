import { useState } from "react";
import { DayPicker } from "react-day-picker";
import { ru } from "react-day-picker/locale";
import { dateKey } from "../../schedule.js";
import { rangeLabel } from "../analytics.js";
import { parseKey } from "../calendar.js";
import { Icon } from "./Icons.jsx";

// Не <input type="date">: в Telegram на iOS его пикер сразу подставляет
// дату и закрывается (см. BookingSheet.jsx). Сетка — тот же
// react-day-picker и те же классы, что в MonthGrid.jsx, без его CSS.
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

// `className` вынут из `rest`, как в MonthGrid: иначе DayPicker затрёт классы состояния.
function DayButton({ day, modifiers, className, ...rest }) {
  const cls = [className || "rdp-day-btn"];
  if (modifiers.rStart || modifiers.rEnd) cls.push("is-selected");
  else if (modifiers.rMid) cls.push("is-in-range");
  if (modifiers.today) cls.push("is-today");
  if (modifiers.outside) cls.push("is-outside");
  return (
    <button type="button" className={cls.join(" ")} {...rest}>
      <span className="rdp-day-num">{day.date.getDate()}</span>
    </button>
  );
}

/**
 * Свой период «с … по …» для «Аналитики». Первое нажатие — начало,
 * второе — конец; нажатие раньше начала или по уже готовому периоду
 * начинает заново. Цифры вкладки не меняются, пока не нажата «Применить»
 * (без конца — период из одного дня). «Сбросить» — этот месяц.
 */
export default function RangePicker({ from, to, onApply, onReset }) {
  const [draft, setDraft] = useState({ from, to });
  const [month, setMonth] = useState(() => {
    const d = from ? parseKey(from) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const pick = (date) => {
    const key = dateKey(date);
    setDraft((d) => (!d.from || d.to || key < d.from ? { from: key, to: null } : { from: d.from, to: key }));
    // День-«хвост» соседнего месяца перелистывает сетку, как в MonthGrid.
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
  };

  const end = draft.to ?? draft.from;
  const rStart = (date) => draft.from != null && dateKey(date) === draft.from;
  const rEnd = (date) => end != null && dateKey(date) === end;
  const rMid = (date) => {
    const k = dateKey(date);
    return draft.from != null && end != null && k > draft.from && k < end;
  };

  const title = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(month);
  const hint = !draft.from
    ? "Выберите первый день"
    : draft.to
      ? rangeLabel(draft)
      : `${rangeLabel({ from: draft.from, to: draft.from })} — выберите последний день`;

  return (
    <div className="month-panel an-range">
      <div className="month-head">
        <button
          className="round-btn lg"
          type="button"
          aria-label="Предыдущий месяц"
          onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
        >
          <Icon name="chevronLeft" size={15} />
        </button>
        <span className="month-title">{title.charAt(0).toUpperCase() + title.slice(1)}</span>
        <button
          className="round-btn lg"
          type="button"
          aria-label="Следующий месяц"
          onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
        >
          <Icon name="chevronRight" size={15} />
        </button>
      </div>
      <DayPicker
        locale={ru}
        month={month}
        onMonthChange={setMonth}
        hideNavigation
        showOutsideDays
        onDayClick={pick}
        classNames={classNames}
        components={{ DayButton }}
        modifiers={{ rStart, rEnd, rMid }}
      />
      <p className="an-range-hint" aria-live="polite">
        {hint}
      </p>
      <div className="an-range-actions">
        <button
          className="btn-save"
          type="button"
          disabled={!draft.from}
          onClick={() => onApply({ from: draft.from, to: end })}
        >
          Применить
        </button>
        <button className="btn-outline" type="button" onClick={onReset}>
          Сбросить
        </button>
      </div>
    </div>
  );
}
