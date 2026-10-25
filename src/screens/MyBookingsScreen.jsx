import { useEffect, useState } from "react";
import {
  cancelMyBooking,
  changesToast,
  refreshMyBookings,
  useMyBookings,
} from "../bookings.js";
import { useContent } from "../content.js";
import { formatPrice } from "../money.js";
import { isPast, labelForKey } from "../schedule.js";
import { setReminders, useSession } from "../supabase.js";
import {
  botCanWrite,
  cancelMessage,
  haptic,
  requestWriteAccess,
  sendToMaster,
  showConfirm,
} from "../telegram.js";
import {
  Icon,
  PrimaryButton,
  Screen,
  TextButton,
  Title,
} from "../ui.jsx";

const CRUMB = "Мои записи";

// Название — из прайса, если услуга ещё есть, иначе то, что сохранено в
// самой записи. Цену и длительность берём из записи — они денормализованы,
// чтобы правка прайса не переписывала историю.
function serviceName(services, b) {
  return services.find((s) => s.id === b.serviceId)?.name || b.serviceName || "Услуга";
}

/** Эмодзи живут только в сообщениях мастеру, не в интерфейсе. */
function serviceLabelForMessage(services, b) {
  const s = services.find((x) => x.id === b.serviceId);
  return s ? `${s.emoji} ${s.name}` : `💅 ${b.serviceName || "Услуга"}`;
}

const STATUS = {
  ok: { cls: "status ok", icon: "checkSm", text: "Запись подтверждена" },
  cancelled: { cls: "status cancelled", icon: "info", text: "Отменена мастером" },
  new: { cls: "status", icon: "clockSm", text: "Ожидает подтверждения" },
};

function UpcomingCard({ booking, title, onCancel, onReschedule }) {
  const cancelled = booking.status === "cancelled";
  const s = STATUS[booking.status] ?? STATUS.new;
  return (
    <div className="book-card">
      <div className="book-head">
        <p>{title}</p>
        <span className="price sm">{formatPrice(booking.price)}</span>
      </div>
      <p className="book-meta">
        {labelForKey(booking.day)} · {booking.time}
      </p>
      {booking.comment && <p className="book-meta">{booking.comment}</p>}
      <div className="book-foot">
        <span className={s.cls}>
          <Icon name={s.icon} size={14} />
          {s.text}
        </span>
        {!cancelled && (
          <span>
            <button className="btn-link" type="button" onClick={() => onReschedule(booking)}>
              Перенести
            </button>{" "}
            <button className="btn-link" type="button" onClick={() => onCancel(booking)}>
              Отменить
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** 24 → "за сутки", 3 → "за 3 часа", 12 → "за 12 часов". */
function beforeLabel(hours) {
  if (hours === 24) return "за сутки";
  if (hours === 48) return "за двое суток";
  if (hours === 72) return "за трое суток";
  const n10 = hours % 10;
  const n100 = hours % 100;
  const word =
    n10 === 1 && n100 !== 11 ? "час" : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? "часа" : "часов";
  return `за ${hours} ${word}`;
}

/**
 * Напоминания о подтверждённой записи от бота (Edge Function
 * send-reminders). Включение сначала просит у Telegram разрешение боту
 * писать — без него сообщение не дойдёт. Отказ — не включаем.
 */
function RemindersRow({ hours, onToast }) {
  const { reminders } = useSession();
  const [busy, setBusy] = useState(false);
  if (reminders === null) return null;

  const toggle = async () => {
    if (busy) return;
    const next = !reminders;
    setBusy(true);
    haptic("select");
    if (next && !botCanWrite()) {
      const granted = await requestWriteAccess();
      if (granted === false) {
        setBusy(false);
        onToast("Без разрешения бот не сможет прислать напоминание.");
        return;
      }
    }
    const res = await setReminders(next);
    setBusy(false);
    if (!res.ok) {
      haptic("error");
      onToast("Не удалось сохранить — проверьте связь и попробуйте ещё раз.");
      return;
    }
    onToast(next ? "Напомним о записи в Telegram." : "Напоминания выключены.");
  };

  return (
    <div className="reminder-row">
      <span className="list-main">
        <span className="day-label">Напоминать о записи</span>
        <span className="day-meta">
          Бот пришлёт сообщение {beforeLabel(hours)} до подтверждённой записи
        </span>
      </span>
      <button
        className="switch"
        type="button"
        role="switch"
        aria-checked={reminders}
        aria-label="Напоминать о записи"
        disabled={busy}
        onClick={toggle}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}

export default function MyBookingsScreen({ onBack, onBook, onReschedule }) {
  const { status, list: bookings } = useMyBookings();
  const [toast, setToast] = useState("");
  const { settings, services, activeServices } = useContent();
  const masterName = settings.masterName;

  // Стор уже может быть загружен (главная) — экран рисуется сразу, а
  // свежие данные дочитываются. App.jsx тоже перечитывает на входе сюда;
  // одновременные вызовы refreshMyBookings() сливаются в один запрос.
  useEffect(() => {
    let cancelled = false;
    refreshMyBookings().then(({ changes }) => {
      if (!cancelled && changes.length) setToast(changesToast(changes));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const cancel = (booking) => {
    showConfirm("Отменить запись?", async (ok) => {
      if (!ok) return;
      haptic("warning");
      // Отмечаем на сервере ДО sendToMaster (он закрывает мини-апп):
      // мастер увидит отмену в кабинете, окно освободится для других.
      const noted = await cancelMyBooking(booking.id);
      if (!noted) {
        haptic("error");
        setToast("Не удалось отменить запись — проверьте связь и попробуйте ещё раз.");
        return;
      }
      setToast(`Запись отменена — ${masterName} увидит это в кабинете.`);
      showConfirm(`Сообщить об отмене ${masterName}?`, (send) => {
        if (!send) return;
        sendToMaster(
          cancelMessage({
            serviceName: serviceLabelForMessage(services, booking),
            dateLabel: labelForKey(booking.day),
            time: booking.time,
          })
        );
      });
    });
  };

  // Перенос — в шаги записи (App.jsx), с той же услугой. Если услуги в
  // прайсе больше нет, переносить не на что: сервер тоже откажет.
  const reschedule = (booking) => {
    const service = activeServices.find((s) => s.id === booking.serviceId);
    if (!service) {
      setToast("Этой услуги больше нет в прайсе — отмените запись и запишитесь заново.");
      return;
    }
    haptic("select");
    onReschedule(booking, service);
  };

  const upcoming = bookings.filter((b) => !isPast(b));
  const past = bookings.filter(isPast).reverse();

  if (status !== "ready") {
    return (
      <Screen crumb={CRUMB} onBack={onBack}>
        <Title>Мои записи</Title>
        {status === "error" ? (
          <div className="blank tall">
            <p>Не удалось загрузить записи</p>
            <TextButton onClick={() => refreshMyBookings()}>Повторить</TextButton>
          </div>
        ) : (
          <div className="blank tall">Загрузка…</div>
        )}
      </Screen>
    );
  }

  return (
    <Screen
      crumb={CRUMB}
      onBack={onBack}
      toast={toast}
      footer={
        <PrimaryButton onClick={onBook}>
          {upcoming.length > 0 ? "Записаться ещё" : "Записаться"}
        </PrimaryButton>
      }
    >
      <Title>Мои записи</Title>

      {upcoming.length > 0 && (
        <>
          <p className="eyebrow">Предстоящие</p>
          <div className="stack">
            {upcoming.map((b) => (
              <UpcomingCard
                key={b.id}
                booking={b}
                title={serviceName(services, b)}
                onCancel={cancel}
                onReschedule={reschedule}
              />
            ))}
          </div>
        </>
      )}

      {past.length > 0 && (
        <>
          <p className="eyebrow">Прошедшие</p>
          <div className="divided flush">
            {past.map((b) => (
              <div key={b.id} className="past-row">
                <span className="list-main">
                  <span className="day-label">{serviceName(services, b)}</span>
                  <span className="day-meta">
                    {labelForKey(b.day)} · {b.time}
                  </span>
                </span>
                <span className="price xs">{formatPrice(b.price)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {bookings.length === 0 && (
        <div className="blank tall">Пока нет записей</div>
      )}

      {settings.reminderHours > 0 && (
        <RemindersRow hours={settings.reminderHours} onToast={setToast} />
      )}

      <p className="note">
        Записи привязаны к вашему аккаунту Telegram — откройте приложение на
        любом устройстве, и они будут здесь. {masterName} узнаёт о заявке из
        сообщения в чате; статус здесь меняется, когда она подтверждает,
        переносит или отменяет запись.
      </p>
    </Screen>
  );
}
