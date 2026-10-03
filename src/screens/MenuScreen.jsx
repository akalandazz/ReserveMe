import { useMyBookings } from "../bookings.js";
import { useContent } from "../content.js";
import { isPast, labelForKey } from "../schedule.js";
import { tgUser } from "../telegram.js";
import { Icon, NavRow, PrimaryButton, Screen, TextButton, Title } from "../ui.jsx";

/** Подпись «Написать …» зависит от имени мастера, поэтому список строится
    в компоненте, а не на уровне модуля. */
function menuItems(masterName) {
  return [
    { id: "my", icon: "calendar", label: "Мои записи", counter: true },
    { id: "waitlist", icon: "clock", label: "Хочу окошко" },
    { id: "services", icon: "sparkle", label: "Услуги и цены" },
    { id: "location", icon: "pin", label: "Как меня найти" },
    { id: "contact", icon: "chat", label: `Написать ${masterName}` },
    { id: "info", icon: "info", label: "Важная информация" },
  ];
}

export default function MenuScreen({ onOpen, toast, name, onSignOut }) {
  // Стор уже отсортирован по времени. Отменённые мастером не считаются:
  // они видны только в «Мои записи».
  const upcoming = useMyBookings().list.filter(
    (b) => !isPast(b) && b.status !== "cancelled"
  );
  const { settings } = useContent();

  const user = tgUser();
  const greeting = user?.first_name
    ? `Привет, ${user.first_name}!`
    : "Добро пожаловать!";
  const next = upcoming[0];

  return (
    <Screen crumb={`${settings.masterName} · Ногтевой сервис`} toast={toast}>
      <p className="greeting">{greeting}</p>
      <Title hero>{settings.masterName}</Title>
      <p className="eyebrow accent">Запись к мастеру</p>

      {next && (
        <div className="next-card">
          <span className="bubble">
            <Icon name="clockSm" size={17} />
          </span>
          <span className="next-main">
            <span className="kicker">
              Ближайшая запись · {next.status === "ok" ? "подтверждена" : "ожидает подтверждения"}
            </span>
            <span className="next-line">
              {labelForKey(next.day)}, {next.time}
            </span>
          </span>
        </div>
      )}

      <PrimaryButton inline onClick={() => onOpen("book:service")}>
        Записаться
      </PrimaryButton>

      <div className="panel nav">
        {menuItems(settings.masterName).map((item) => (
          <NavRow
            key={item.id}
            icon={item.icon}
            label={item.label}
            badge={
              item.counter && upcoming.length > 0 ? upcoming.length : undefined
            }
            onClick={() => onOpen(item.id)}
          />
        ))}
      </div>

      {settings.workingHoursText && (
        <p className="note">{settings.workingHoursText}</p>
      )}

      {name && <p className="note center">Вы вошли как {name}</p>}
      <TextButton onClick={onSignOut}>Выйти</TextButton>
    </Screen>
  );
}
