import { useEffect, useState } from "react";
import { useContent } from "../content.js";
import { isPast, labelForKey } from "../schedule.js";
import { loadBookings } from "../storage.js";
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

/** Предстоящие по возрастанию времени — порядок хранения произвольный.
 *  Отменённые мастером не считаются: они живут в «Мои записи» до «Убрать». */
function sortedUpcoming(list) {
  return list
    .filter((b) => !isPast(b) && b.st !== "cancelled")
    .sort((a, b) => (a.d + a.t < b.d + b.t ? -1 : 1));
}

export default function MenuScreen({ onOpen, toast, rev, email, onSignOut }) {
  const [upcoming, setUpcoming] = useState([]);
  const { settings } = useContent();

  // rev растёт, когда синхронизация (App.jsx) поменяла статусы.
  useEffect(() => {
    // StrictMode в dev вызывает эффект дважды — флаг гасит гонку
    let cancelled = false;
    loadBookings().then((list) => {
      if (!cancelled) setUpcoming(sortedUpcoming(list));
    });
    return () => {
      cancelled = true;
    };
  }, [rev]);

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
              Ближайшая запись · {next.st === "ok" ? "подтверждена" : "ожидает подтверждения"}
            </span>
            <span className="next-line">
              {labelForKey(next.d)}, {next.t}
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

      {email && <p className="note center">Вы вошли как {email}</p>}
      <TextButton onClick={onSignOut}>Выйти</TextButton>
    </Screen>
  );
}
