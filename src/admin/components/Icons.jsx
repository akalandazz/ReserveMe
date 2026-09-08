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
