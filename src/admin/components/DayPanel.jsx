import { formatPrice } from "../../money.js";
import { labelForKey, toHHMM } from "../../schedule.js";
import {
  blockSlot,
  canMessageClient,
  clientSeesStatus,
  closeDay,
  openDay,
  saveWorkingHours,
  unblockSlot,
} from "../api.js";
import { buildDayRows, hoursFor, isBookingPast, parseKey } from "../calendar.js";
import { Icon } from "./Icons.jsx";

/**
 * Панель одного дня. Запись — карточка с кнопкой «Изменить»:
 * подтвердить, перенести и отменить — всё в листе записи
 * (BookingSheet), там же, где мастер видит сообщение для клиента.
 * Рядом корзина — убрать запись без сообщения в чате, через
 * подтверждение под карточкой. Запись из мини-аппа при этом отменяется,
 * и клиент видит «Отменена мастером» (cancelBooking в api.js);
 * остальные удаляются насовсем.
 */
export default function DayPanel({
  settings,
  daysOff,
  bookings,
  blockedSlots,
  selectedKey,
  onShift,
  onToast,
  onError,
  onEditBooking,
  busy,
  confirmDel,
  setConfirmDel,
  onDeleteBooking,
}) {
  const dow = parseKey(selectedKey).getDay();
  const hours = hoursFor(settings, dow);
  const closedByOff = daysOff.includes(selectedKey);
  const { closed, rows, freeCount } = buildDayRows(
    settings,
    daysOff,
    bookings,
    blockedSlots,
    selectedKey
  );
  const wrap = async (promise, okMsg) => {
    const res = await promise;
    if (res.ok) {
      if (okMsg) onToast(okMsg);
    } else {
      onError(res.error);
    }
  };

  const isConfirming = (id) => confirmDel?.kind === "booking" && confirmDel.id === id;
  // Повторный тап по корзине — закрыть своё подтверждение.
  const askDelete = (id) =>
    setConfirmDel(isConfirming(id) ? null : { kind: "booking", id });

  const toggleBlock = (minute, isBlocked) =>
    wrap(isBlocked ? unblockSlot(selectedKey, minute) : blockSlot(selectedKey, minute));
  const toggleDayClosed = () => {
    if (!hours) {
      // Выходной по недельному графику — открываем весь этот день недели,
      // как в макете. Разового исключения из выходного графика нет:
      // days_off умеет только закрывать рабочий день, а не открывать нерабочий.
      const next = { ...settings.workingHours, [dow]: { from: "10:00", to: "19:00" } };
      wrap(saveWorkingHours(next), "День снова открыт для записи.");
      return;
    }
    wrap(
      closedByOff ? openDay(selectedKey) : closeDay(selectedKey),
      closedByOff ? "День снова открыт для записи." : "День закрыт для записи."
    );
  };

  return (
    <div className="day-panel">
      <div className="day-head">
        <button className="round-btn" type="button" aria-label="Предыдущий день" onClick={() => onShift(-1)}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="day-title-wrap">
          <span className="day-title">{labelForKey(selectedKey)}</span>
          <span className="day-sub">
            {closed
              ? "нерабочий день"
              : `${hours.from}–${hours.to} · записей: ${rows.filter((r) => r.type === "booking").length}`}
          </span>
        </span>
        <button className="round-btn" type="button" aria-label="Следующий день" onClick={() => onShift(1)}>
          <Icon name="chevronRight" size={14} />
        </button>
      </div>

      {closed ? (
        <div className="day-empty">
          <p>{!hours ? "Выходной по графику" : "День закрыт вручную"}</p>
          <button className="pill-btn" type="button" onClick={toggleDayClosed}>
            {!hours ? "Сделать рабочим днём" : "Открыть день"}
          </button>
        </div>
      ) : (
        <div>
          {rows.map((r) => (
            <div className="day-row" key={r.time}>
              <span className="day-row-time">{r.time}</span>
              <span className="day-row-body">
                {r.type === "booking" ? (
                  <>
                    <span className="booking-card has-edit" data-status={r.booking.status}>
                      <span className="booking-body">
                        <span className="booking-head">
                          <span className="booking-name">
                            {r.booking.client_name || "Клиент"} · {r.booking.service_name}
                          </span>
                          <span className="booking-price">{formatPrice(r.booking.price)}</span>
                        </span>
                        <span className="booking-meta">
                          {r.time}–{toHHMM(r.booking.start_min + r.booking.duration)}
                          {" · "}
                          {r.booking.status === "new" ? "ждёт подтверждения" : "подтверждена"}
                          {r.booking.comment ? ` · «${r.booking.comment}»` : ""}
                        </span>
                      </span>
                      <button
                        className="booking-edit"
                        type="button"
                        onClick={() => onEditBooking(r.booking.id)}
                      >
                        Изменить
                      </button>
                      <button
                        className="booking-del"
                        type="button"
                        aria-label="Удалить запись"
                        aria-expanded={isConfirming(r.booking.id) ? "true" : "false"}
                        onClick={() => askDelete(r.booking.id)}
                      >
                        <Icon name="trash" size={17} />
                      </button>
                    </span>
                    {isConfirming(r.booking.id) && (
                      <span className="del-confirm" role="group" aria-label="Удаление записи">
                        <span className="del-confirm-text">
                          {canMessageClient(r.booking) && !isBookingPast(r.booking)
                            ? "Отменить запись? Откроется чат с клиентом."
                            : clientSeesStatus(r.booking)
                              ? "Отменить запись? Клиент увидит это в мини-аппе."
                              : "Удалить запись без восстановления?"}
                        </span>
                        <span className="del-confirm-actions">
                          <button
                            className="btn-danger-fill"
                            type="button"
                            disabled={!!busy}
                            onClick={() => onDeleteBooking(r.booking.id)}
                          >
                            {busy === `del-booking-${r.booking.id}` && (
                              <span className="btn-spinner" aria-hidden="true" />
                            )}
                            Удалить
                          </button>
                          <button
                            className="btn-outline"
                            type="button"
                            onClick={() => setConfirmDel(null)}
                          >
                            Нет
                          </button>
                        </span>
                      </span>
                    )}
                  </>
                ) : r.isOpenSlot ? (
                  // Строка — подложка, не кнопка: «Закрыть» стоит в полную
                  // её высоту (≥44px).
                  <span className="free-slot slot-open has-actions">
                    <span className="free-slot-label">Свободно</span>
                    <button
                      type="button"
                      className="slot-btn is-close"
                      onClick={() => toggleBlock(r.minute, false)}
                    >
                      Закрыть
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="free-slot slot-blocked"
                    onClick={() => toggleBlock(r.minute, true)}
                  >
                    <span className="free-slot-label">Закрыто</span>
                    <span className="free-slot-action">Открыть</span>
                  </button>
                )}
              </span>
            </div>
          ))}
          <div className="day-foot">
            <span className="day-foot-note">Свободно окошек: {freeCount}</span>
            <button className="btn-close-day" type="button" onClick={toggleDayClosed}>
              Закрыть день
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
