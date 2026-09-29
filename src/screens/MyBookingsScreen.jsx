import { useEffect, useState } from "react";
import { useContent } from "../content.js";
import { isPast, labelForKey } from "../schedule.js";
import { loadBookings, removeBooking } from "../storage.js";
import { cancelOwnBooking } from "../supabase.js";
import { changesToast, syncBookings } from "../sync.js";
import { cancelMessage, haptic, sendToMaster, showConfirm } from "../telegram.js";
import {
  Icon,
  PrimaryButton,
  Screen,
  Title,
} from "../ui.jsx";

const CRUMB = "Мои записи";

// Ищем по всем услугам, включая скрытые: у прошлой записи должно
// остаться название. Цену и длительность берём из самой записи —
// они денормализованы, чтобы правка прайса не переписывала историю.
function serviceName(services, b) {
  return services.find((s) => s.id === b.s)?.name ?? "Услуга";
}

/** Эмодзи живут только в сообщениях мастеру, не в интерфейсе. */
function serviceLabelForMessage(services, b) {
  const s = services.find((x) => x.id === b.s);
  return s ? `${s.emoji} ${s.name}` : "💅 Услуга";
}

const STATUS = {
  ok: { cls: "status ok", icon: "checkSm", text: "Запись подтверждена" },
  cancelled: { cls: "status cancelled", icon: "info", text: "Отменена мастером" },
  new: { cls: "status", icon: "clockSm", text: "Ожидает подтверждения" },
};

function UpcomingCard({ booking, title, onCancel, onDismiss }) {
  const cancelled = booking.st === "cancelled";
  const s = STATUS[booking.st] ?? STATUS.new;
  return (
    <div className="book-card">
      <div className="book-head">
        <p>{title}</p>
        <span className="price sm">{booking.p} ₾</span>
      </div>
      <p className="book-meta">
        {labelForKey(booking.d)} · {booking.t}
      </p>
      {booking.c && <p className="book-meta">{booking.c}</p>}
      <div className="book-foot">
        <span className={s.cls}>
          <Icon name={s.icon} size={14} />
          {s.text}
        </span>
        <button
          className="btn-link"
          type="button"
          onClick={() => (cancelled ? onDismiss(booking) : onCancel(booking))}
        >
          {cancelled ? "Убрать" : "Отменить"}
        </button>
      </div>
    </div>
  );
}

export default function MyBookingsScreen({ onBack, onBook, rev }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  const { settings, services } = useContent();
  const masterName = settings.masterName;

  // Сначала показываем локальные записи, потом дозапрашиваем статусы
  // (src/sync.js): экран не должен ждать сети, чтобы отрисоваться, — как
  // и busy в content.js, статус необязателен для показа карточки.
  // rev — App.jsx синхронизировал сам (возврат во вкладку).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await loadBookings();
      if (cancelled) return;
      setBookings(list);
      setLoading(false);

      const { list: next, changes } = await syncBookings();
      if (cancelled) return;
      setBookings(next);
      if (changes.length) setToast(changesToast(changes));
    })();
    return () => {
      cancelled = true;
    };
  }, [rev]);

  // Отменённую мастером карточку клиент убирает сам — после того, как увидел.
  const dismiss = async (booking) => {
    setBookings(await removeBooking(booking.id));
  };

  const cancel = (booking) => {
    showConfirm("Отменить запись?", async (ok) => {
      if (!ok) return;
      haptic("warning");
      const next = await removeBooking(booking.id);
      setBookings(next);
      // Отмечаем на сервере ДО sendToMaster (он закрывает мини-апп):
      // мастер увидит отмену в кабинете, окно освободится для других.
      const noted = await cancelOwnBooking(booking.k);
      setToast(
        noted
          ? `Запись отменена — ${masterName} увидит это в кабинете.`
          : `Запись удалена у вас. Сообщите об отмене ${masterName} в чате.`
      );
      // Мастер знает о записи только из чата — предлагаем написать сразу
      showConfirm(`Сообщить об отмене ${masterName}?`, (send) => {
        if (!send) return;
        sendToMaster(
          cancelMessage({
            serviceName: serviceLabelForMessage(services, booking),
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
              <UpcomingCard
                key={b.id}
                booking={b}
                title={serviceName(services, b)}
                onCancel={cancel}
                onDismiss={dismiss}
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
        Записи видны только вам. {masterName} узнаёт о них из сообщения в чате;
        статус здесь меняется, когда она подтверждает или отменяет заявку.
      </p>
    </Screen>
  );
}
