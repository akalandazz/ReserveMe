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
  trash: {
    w: 1.5,
    d: [
      "M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2",
      "M6.5 7l.9 12.1a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7",
      "M10 11v5.5M14 11v5.5",
    ],
  },
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
  chat: { w: 1.5, d: ["M4 5.5h16v11H10l-5 3.5v-3.5H4z"] },
  phone: {
    w: 1.5,
    d: ["M6 3.5h3l1.8 4.6-2.3 1.4a11 11 0 0 0 6 6l1.4-2.3 4.6 1.8v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4 5.5a2 2 0 0 1 2-2Z"],
  },
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
