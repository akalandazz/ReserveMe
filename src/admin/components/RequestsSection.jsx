import { useMemo, useState } from "react";
import { labelForKey, toHHMM } from "../../schedule.js";
import { approveBooking, deleteBooking } from "../api.js";
import { isBookingPast } from "../calendar.js";
import { Icon } from "./Icons.jsx";

const PER_PAGE = 3;

/**
 * Новые заявки — те, что клиент ещё не подтвердил (status "new") и
 * которые ещё не прошли. «Отклонить» = удалить строку: мастер пишет
 * клиенту сам, sendToMaster() здесь не вызывается никогда — он закрыл
 * бы мини-апп (см. CLAUDE.md).
 */
export default function RequestsSection({ bookings, busy, busyThen, onToast, onError }) {
  const [page, setPage] = useState(0);

  const pending = useMemo(
    () =>
      bookings
        .filter((b) => b.status === "new" && !isBookingPast(b))
        .sort((a, b) => a.day.localeCompare(b.day) || a.start_min - b.start_min),
    [bookings]
  );

  if (pending.length === 0) {
    return <div className="blank tall">Новых заявок нет</div>;
  }

  const pages = Math.max(1, Math.ceil(pending.length / PER_PAGE));
  const cur = Math.min(page, pages - 1);
  const from = cur * PER_PAGE;
  const shown = pending.slice(from, from + PER_PAGE);

  const approve = (id) => {
    busyThen(`appr-${id}`, 500, async () => {
      const res = await approveBooking(id);
      if (res.ok) onToast("Запись подтверждена. Напишите клиенту в чате.");
      else onError(res.error);
    });
  };

  const decline = (id) => {
    busyThen(`drop-${id}`, 450, async () => {
      const res = await deleteBooking(id);
      if (res.ok) onToast("Заявка отклонена. Напишите клиенту в чате.");
      else onError(res.error);
    });
  };

  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Новые заявки</p>
        <span className="section-head-note">
          {from + 1}–{Math.min(from + PER_PAGE, pending.length)} из {pending.length}
        </span>
      </div>

      <div className="requests-list">
        {shown.map((b) => {
          const approving = busy === `appr-${b.id}`;
          const declining = busy === `drop-${b.id}`;
          return (
            <div className={`request-card${declining ? " is-declining" : ""}`} key={b.id}>
              <div className="request-head">
                <p className="request-name">{b.service_name}</p>
                <span className="request-price">{b.price} ₾</span>
              </div>
              <p className="request-meta">
                {labelForKey(b.day)} · {toHHMM(b.start_min)}
                {b.client_name ? ` · ${b.client_name}` : ""}
              </p>
              <div className="request-actions">
                <button
                  className="btn-approve"
                  type="button"
                  disabled={!!busy}
                  onClick={() => approve(b.id)}
                >
                  {approving && <span className="btn-spinner" aria-hidden="true" />}
                  {approving ? "Подтверждаем" : "Подтвердить"}
                </button>
                <button
                  className="btn-decline"
                  type="button"
                  disabled={!!busy}
                  onClick={() => decline(b.id)}
                >
                  Отклонить
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {pages > 1 && (
        <div className="request-pager">
          <button
            className="pager-btn"
            type="button"
            aria-label="Предыдущие заявки"
            disabled={cur === 0}
            onClick={() => setPage(Math.max(0, cur - 1))}
          >
            <Icon name="chevronLeft" size={15} />
          </button>
          <span className="pager-label">
            {cur + 1} / {pages}
          </span>
          <button
            className="pager-btn"
            type="button"
            aria-label="Следующие заявки"
            disabled={cur >= pages - 1}
            onClick={() => setPage(Math.min(pages - 1, cur + 1))}
          >
            <Icon name="chevronRight" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
