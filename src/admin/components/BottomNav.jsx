import { Icon } from "./Icons.jsx";

const TABS = [
  { id: "schedule", label: "Расписание", icon: "calendar" },
  { id: "requests", label: "Заявки", icon: "inbox" },
  { id: "clients", label: "Клиенты", icon: "users" },
  { id: "settings", label: "Настройки", icon: "settings" },
];

export default function BottomNav({ active, onChange, pendingCount }) {
  return (
    <nav className="bottom-nav">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className="bottom-nav-item"
          aria-current={active === t.id ? "true" : "false"}
          onClick={() => onChange(t.id)}
        >
          <span className="bottom-nav-icon-wrap">
            <Icon name={t.icon} size={19} />
            {t.id === "requests" && pendingCount > 0 && (
              <span className="bottom-nav-badge">{pendingCount}</span>
            )}
          </span>
          <span className="bottom-nav-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
