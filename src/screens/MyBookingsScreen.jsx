import { useEffect, useState } from "react";
import { useContent } from "../content.js";
import { isPast, labelForKey } from "../schedule.js";
import { loadBookings, removeBooking, saveBookings } from "../storage.js";
import { fetchBookingStatuses } from "../supabase.js";
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

/**
 * Подтянуть статусы с сервера: мастер подтверждает заявку в кабинете,
 * и локальная запись об этом сама не узнает.
 *
 * Спрашиваем только про ещё не подтверждённые и не прошедшие — статус
 * "ok" обратно в "new" не превращается, а прошедшую запись подтверждать
 * поздно. Записи без токена (заведены до этой версии, либо в вебвью без
 * crypto) пропускаем: спросить про них нечем.
 *
 * @returns {Promise<object[]|null>} новый список или null, если менять нечего.
 */
async function syncStatuses(list) {
  const pending = list.filter((b) => b.k && b.st !== "ok" && !isPast(b));
  if (pending.length === 0) return null;

  const byToken = await fetchBookingStatuses(pending.map((b) => b.k));
  // null — не дозвонились; пустая Map — строк нет (мастер удалила заявку
  // либо insert не доехал). Ни то ни другое не повод менять статус:
  // «ожидает подтверждения» — безопасный по умолчанию ответ.
  if (!byToken || byToken.size === 0) return null;

  let changed = false;
  const next = list.map((b) => {
    const status = b.k ? byToken.get(b.k) : undefined;
    if (!status || status === b.st) return b;
    changed = true;
    return { ...b, st: status };
  });

  return changed ? next : null;
}

function UpcomingCard({ booking, title, onCancel }) {
  const confirmed = booking.st === "ok";
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
        <span className={confirmed ? "status ok" : "status"}>
          <Icon name={confirmed ? "checkSm" : "clockSm"} size={14} />
          {confirmed ? "Запись подтверждена" : "Ожидает подтверждения"}
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
  const { settings, services } = useContent();
  const masterName = settings.masterName;

  // Сначала показываем локальные записи, потом дозапрашиваем статусы:
  // экран не должен ждать сети, чтобы отрисоваться, — как и busy в
  // content.js, статус необязателен для показа карточки.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await loadBookings();
      if (cancelled) return;
      setBookings(list);
      setLoading(false);

      const next = await syncStatuses(list);
      if (cancelled || !next) return;
      // saveBookings отдаёт то, что реально легло в хранилище (обрезанное
      // до лимита CloudStorage), — показываем именно его.
      const saved = await saveBookings(next);
      if (!cancelled) setBookings(saved);
    })();
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
        `Запись удалена у вас. Сообщите об отмене ${masterName} в чате.`
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
        статус здесь меняется, когда она подтверждает заявку.
      </p>
    </Screen>
  );
}
