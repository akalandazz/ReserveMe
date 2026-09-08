// Презентационные примитивы. Без состояния — кроме ThemeToggle,
// который только читает текущую тему из src/theme.js.

import { useSyncExternalStore } from "react";
import { HAS_TG_BACK } from "./telegram.js";
import { currentTheme, subscribeTheme, toggleTheme } from "./theme.js";

/* ─── Иконки ────────────────────────────────────────────────────
   Линейный набор в одной сетке 24×24. Толщина обводки у каждой своя,
   иначе мелкие (14–17px) выглядят жирнее крупных.                */

const ICONS = {
  back: { w: 1.5, d: ["M14.5 5 8 12l6.5 7"] },
  chevron: { w: 1.3, d: ["M9.5 5 16 12l-6.5 7"] },
  moon: { w: 1.4, d: ["M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8Z"] },
  calendar: {
    w: 1.3,
    d: ["M6.5 5h11a3 3 0 0 1 3 3v9.5a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z", "M8 3.5v3M16 3.5v3M3.5 10h17"],
  },
  clock: { w: 1.3, d: ["M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z", "M12 7.5V12l3.2 2"] },
  clockSm: { w: 1.4, d: ["M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z", "M12 7.8V12l3 1.8"] },
  sparkle: {
    w: 1.3,
    d: [
      "M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7L12 3.5Z",
      "M18 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z",
    ],
  },
  pin: {
    w: 1.3,
    d: ["M12 21c4-4.6 6-7.9 6-10.4A6 6 0 0 0 6 10.6C6 13.1 8 16.4 12 21Z", "M12 8.1a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Z"],
  },
  chat: {
    w: 1.3,
    d: ["M20.5 12.2c0 3.9-3.8 7-8.5 7-.9 0-1.8-.1-2.6-.3l-4.9 1.6 1.4-4.1a6.6 6.6 0 0 1-1.9-4.4c0-3.9 3.8-7 8.5-7s8 3.2 8 7.2Z"],
  },
  info: { w: 1.3, d: ["M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z", "M12 11v5.5M12 7.9h.01"] },
  up: { w: 1.5, d: ["M5 15.5 12 9l7 6.5"] },
  down: { w: 1.5, d: ["M5 9l7 6.5L19 9"] },
  pencil: {
    w: 1.4,
    d: ["M4 20h4L18 10a2.83 2.83 0 0 0-4-4L4 16v4Z", "M13.5 6.5l4 4"],
  },
  gear: {
    w: 1.3,
    d: [
      "M12 8.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Z",
      "M19.2 13.2c.1-.4.1-.8.1-1.2s0-.8-.1-1.2l2-1.5-2-3.4-2.3 1a7.3 7.3 0 0 0-2-1.2l-.3-2.4h-4l-.4 2.4a7.3 7.3 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.3 7.3 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.3 7.3 0 0 0 2 1.2l.4 2.4h4l.3-2.4a7.3 7.3 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5Z",
    ],
  },
};

export function Icon({ name, size = 19, className }) {
  const icon = ICONS[name];
  if (!icon) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={icon.w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icon.d.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/* ─── Шапка ─────────────────────────────────────────────────────── */

function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "light");
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

/**
 * Каркас экрана: липкая шапка с «хлебной крошкой», тело и липкая
 * нижняя панель. Тело — flex:1 в колонке высотой 100dvh, поэтому
 * панель не наезжает на последнюю строку списка без доп. отступов.
 *
 * Внутри Telegram кнопка «назад» рисуется самим клиентом в шапке,
 * поэтому внутриэкранную показываем только в браузере.
 */
export function Screen({ crumb, onBack, toast, footer, children }) {
  return (
    <div className="shell">
      <div className="topbar">
        {onBack && !HAS_TG_BACK && (
          <button
            className="icon-btn is-back"
            type="button"
            onClick={onBack}
            aria-label="Назад"
          >
            <Icon name="back" size={18} />
          </button>
        )}
        <span className="crumb">{crumb}</span>
        <ThemeToggle />
      </div>

      {toast && <div className="toast">{toast}</div>}

      <div className="screen-body">{children}</div>

      {footer && <div className="footer-bar">{footer}</div>}
    </div>
  );
}

/* ─── Загрузка контента ─────────────────────────────────────────
   Контент салона лежит в базе, поэтому до первого ответа рисовать
   нечего — даже имя мастера в «хлебной крошке» приходит оттуда.
   Возвращающийся клиент этих экранов не видит: кэш читается
   синхронно при загрузке src/content.js.                          */

export function BootLoading() {
  return (
    <Screen crumb="Загрузка">
      <div className="blank tall">Загрузка…</div>
    </Screen>
  );
}

export function BootError({ message, onRetry }) {
  return (
    <Screen crumb="Ошибка">
      <div className="blank">
        <p>Не удалось загрузить данные</p>
        {message && <p className="note">{message}</p>}
        <TextButton onClick={onRetry}>Повторить</TextButton>
      </div>
      <p className="note center">Проверьте соединение и повторите попытку.</p>
    </Screen>
  );
}

/* ─── Заголовки и мелочи ────────────────────────────────────────── */

export function Title({ children, hero }) {
  return <h1 className={hero ? "title-hero" : "title"}>{children}</h1>;
}

export function Eyebrow({ children, accent }) {
  return <p className={accent ? "eyebrow accent" : "eyebrow"}>{children}</p>;
}

/** Полоска прогресса записи: current — от 1 до total. */
export function Steps({ total, current }) {
  return (
    <div className="steps" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < current ? "on" : undefined} />
      ))}
    </div>
  );
}

/* ─── Строки списков ────────────────────────────────────────────── */

/** Пункт главного меню: иконка, подпись, счётчик, шеврон. */
export function NavRow({ icon, label, badge, onClick }) {
  return (
    <button className="nav-row" type="button" onClick={onClick}>
      <Icon name={icon} className="nav-icon" />
      <span className="nav-label">{label}</span>
      {badge != null && <span className="badge">{badge}</span>}
      <Icon name="chevron" size={16} className="nav-chevron" />
    </button>
  );
}

/** Строка прайса: название, мета, цена справа. */
export function ListRow({ title, meta, price, onClick }) {
  return (
    <button className="list-row" type="button" onClick={onClick}>
      <span className="list-main">
        <span className="list-title">{title}</span>
        {meta && <span className="list-meta">{meta}</span>}
      </span>
      {price && <span className="price">{price}</span>}
    </button>
  );
}

/** Карточка-опция: выбор услуги, времени суток. */
export function OptionRow({
  title,
  meta,
  price,
  selected,
  wide,
  onClick,
}) {
  return (
    <button
      className={wide ? "option wide" : "option"}
      type="button"
      onClick={onClick}
      aria-pressed={selected ? "true" : "false"}
    >
      <span className="list-main">
        <span className="option-title">{title}</span>
        {meta && <span className="option-meta">{meta}</span>}
      </span>
      {price && <span className="price sm">{price}</span>}
    </button>
  );
}

export function Chip({ label, pressed, onClick }) {
  return (
    <button
      className="chip"
      type="button"
      onClick={onClick}
      aria-pressed={pressed ? "true" : "false"}
    >
      {label}
    </button>
  );
}

/* ─── Кнопки ────────────────────────────────────────────────────── */

export function PrimaryButton({ children, disabled, inline, onClick }) {
  return (
    <button
      className={inline ? "btn-primary inline" : "btn-primary"}
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function OutlineButton({ children, onClick }) {
  return (
    <button className="btn-outline" type="button" onClick={onClick}>
      {children}
    </button>
  );
}

export function TextButton({ children, onClick, danger }) {
  return (
    <button
      className={danger ? "btn-text danger" : "btn-text"}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function PillButton({ children, onClick }) {
  return (
    <button className="btn-pill" type="button" onClick={onClick}>
      {children}
    </button>
  );
}
