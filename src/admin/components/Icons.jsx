// Малый набор иконок кабинета мастера — своя копия, а не импорт из
// src/ui.jsx: страница мастера намеренно изолирована от клиентского
// бандла (см. CLAUDE.md), поэтому дублируем несколько path вместо
// того, чтобы тянуть общий модуль ради пяти иконок.

const PATHS = {
  moon: { w: 1.4, d: ["M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8Z"] },
  chevronLeft: { w: 1.5, d: ["M14.5 5 8 12l6.5 7"] },
  chevronRight: { w: 1.5, d: ["M9.5 5 16 12l-6.5 7"] },
  plus: { w: 1.5, d: ["M12 5v14M5 12h14"] },
  x: { w: 1.5, d: ["M6 6l12 12M18 6 6 18"] },
  calendar: {
    w: 1.5,
    d: [
      "M5.5 6h13a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z",
      "M8 4v4M16 4v4M4.5 10.5h15",
    ],
  },
  inbox: {
    w: 1.5,
    d: ["M5.5 4.5h9l4 4v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15Z", "M9 12h6M9 15.5h6"],
  },
  users: {
    w: 1.5,
    d: [
      "M8.7 11.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2Z",
      "M3.3 19.5a5.4 5.4 0 0 1 10.8 0",
      "M15.3 5.6a3.1 3.1 0 0 1 0 5.9",
      "M16.4 13.9a5.2 5.2 0 0 1 4.3 5.6",
    ],
  },
  settings: {
    w: 1.5,
    d: ["M4 7.5h9M16.5 7.5H20", "M4 16.5h3M10.5 16.5H20", "M13 4.5v6M7.5 13.5v6"],
  },
  telegram: { w: 1.5, d: ["M21 3 3 10.7l6.6 2.3M21 3 15 21l-5.4-8M21 3 9.6 13"] },
};

export function Icon({ name, size = 16 }) {
  const icon = PATHS[name];
  if (!icon) return null;
  return (
    <svg
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
