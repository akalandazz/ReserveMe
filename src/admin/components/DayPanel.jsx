import { useState } from "react";
import { labelForKey } from "../../schedule.js";
import {
  approveBooking,
  blockSlot,
  closeDay,
  deleteBooking,
  moveBooking,
  openDay,
  saveWorkingHours,
  unblockSlot,
} from "../api.js";
import { buildDayRows, hoursFor, parseKey } from "../calendar.js";
import { Icon } from "./Icons.jsx";

export default function DayPanel({
  settings,
  daysOff,
  bookings,
  blockedSlots,
  selectedKey,
  onShift,
  onToast,
  onError,
}) {
  const [moveId, setMoveId] = useState(null);

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
  const moving = bookings.find((b) => b.id === moveId) || null;

  const wrap = async (promise, okMsg) => {
    const res = await promise;
    if (res.ok) {
      if (okMsg) onToast(okMsg);
    } else {
      onError(res.error);
    }
  };

  const approve = (id) => wrap(approveBooking(id), "Запись подтверждена. Напишите клиенту в чате.");
  const cancel = (id) => wrap(deleteBooking(id), "Запись отменена. Сообщите клиенту.");
  const startMove = (id) => setMoveId(id);
  const moveTo = async (minute) => {
    const id = moveId;
    setMoveId(null);
    const hh = String(Math.floor(minute / 60)).padStart(2, "0");
    const mm = String(minute % 60).padStart(2, "0");
    await wrap(moveBooking(id, selectedKey, minute), `Запись перенесена на ${hh}:${mm}. Сообщите клиенту.`);
  };
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

      {moving && (
        <div className="move-banner">
          <span>Выберите новое время для «{moving.service_name}»</span>
          <button className="move-cancel" type="button" onClick={() => setMoveId(null)}>
            Отмена
          </button>
        </div>
      )}

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
                  <span className="booking-card" data-status={r.booking.status}>
                    <span className="booking-head">
                      <span className="booking-name">{r.booking.service_name}</span>
                      <span className="booking-price">{r.booking.price} ₾</span>
                    </span>
                    <span className="booking-meta">
                      {r.booking.client_name || "клиент"} · {r.time}
                      {" · "}
                      {r.booking.status === "new" ? "ждёт подтверждения" : "подтверждена"}
                    </span>
                    <span className="booking-actions">
                      {r.booking.status === "new" && (
                        <button className="link-btn" type="button" onClick={() => approve(r.booking.id)}>
                          Подтвердить
                        </button>
                      )}
                      <button className="link-btn" type="button" onClick={() => startMove(r.booking.id)}>
                        Перенести
                      </button>
                      <button className="link-btn danger" type="button" onClick={() => cancel(r.booking.id)}>
                        Отменить
                      </button>
                    </span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="free-slot"
                    onClick={() =>
                      r.blocked
                        ? toggleBlock(r.minute, true)
                        : moving
                          ? moveTo(r.minute)
                          : toggleBlock(r.minute, false)
                    }
                  >
                    <span className="free-slot-label">{r.blocked ? "Закрыто" : "Свободно"}</span>
                    <span className="free-slot-action">
                      {r.blocked ? "Открыть" : moving ? "Перенести сюда" : "Закрыть"}
                    </span>
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
