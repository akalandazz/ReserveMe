import { useEffect, useState } from "react";
import { MASTER_NAME, findService } from "../data.js";
import { isPast, labelForKey } from "../schedule.js";
import { loadBookings, removeBooking } from "../storage.js";
import { cancelMessage, haptic, sendToMaster, showConfirm } from "../telegram.js";
import {
  Icon,
  PrimaryButton,
  Screen,
  Title,
} from "../ui.jsx";

const CRUMB = "Мои записи";

function serviceName(b) {
  return findService(b.s)?.name ?? "Услуга";
}

/** Эмодзи из data.js живут только в сообщениях мастеру, не в интерфейсе. */
function serviceLabelForMessage(b) {
  const s = findService(b.s);
  return s ? `${s.emoji} ${s.name}` : "💅 Услуга";
}

function UpcomingCard({ booking, onCancel }) {
  return (
    <div className="book-card">
      <div className="book-head">
        <p>{serviceName(booking)}</p>
        <span className="price sm">{booking.p} ₾</span>
      </div>
      <p className="book-meta">
        {labelForKey(booking.d)} · {booking.t}
      </p>
      {booking.c && <p className="book-meta">{booking.c}</p>}
      <div className="book-foot">
        <span className="status">
          <Icon name="clockSm" size={14} />
          Ожидает подтверждения
        </span>
        <button
          className="btn-link"
          type="button"
          onClick={() => onCancel(booking)}
        >
          Отменить
        </button>
      </div>
    </div>
  );
}

export default function MyBookingsScreen({ onBack, onBook }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadBookings().then((list) => {
      if (cancelled) return;
      setBookings(list);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const cancel = (booking) => {
    showConfirm("Отменить запись?", async (ok) => {
      if (!ok) return;
      haptic("warning");
      const next = await removeBooking(booking.id);
      setBookings(next);
      setToast(
        `Запись удалена у вас. Сообщите об отмене ${MASTER_NAME} в чате.`
      );
      // Мастер знает о записи только из чата — предлагаем написать сразу
      showConfirm(`Сообщить об отмене ${MASTER_NAME}?`, (send) => {
        if (!send) return;
        sendToMaster(
          cancelMessage({
            serviceName: serviceLabelForMessage(booking),
            dateLabel: labelForKey(booking.d),
            time: booking.t,
          })
        );
      });
    });
  };

  const upcoming = bookings.filter((b) => !isPast(b));
  const past = bookings.filter(isPast);

  if (loading) {
    return (
      <Screen crumb={CRUMB} onBack={onBack}>
        <Title>Мои записи</Title>
        <div className="blank tall">Загрузка…</div>
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
              <UpcomingCard key={b.id} booking={b} onCancel={cancel} />
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
                  <span className="day-label">{serviceName(b)}</span>
                  <span className="day-meta">
                    {labelForKey(b.d)} · {b.t}
                  </span>
                </span>
                <span className="price xs">{b.p} ₾</span>
              </div>
            ))}
          </div>
        </>
      )}

      {bookings.length === 0 && (
        <div className="blank tall">Пока нет записей</div>
      )}

      <p className="note">
        Записи видны только вам. {MASTER_NAME} узнаёт о них из сообщения в чате
        — дождитесь её подтверждения.
      </p>
    </Screen>
  );
}
