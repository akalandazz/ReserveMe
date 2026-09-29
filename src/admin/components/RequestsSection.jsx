import { useMemo, useState } from "react";
import { labelForKey, toHHMM } from "../../schedule.js";
import { ackCancellation, approveBooking, cancelBooking, clientSeesStatus } from "../api.js";
import { isBookingPast } from "../calendar.js";
import { notifyClient } from "../messages.js";
import { Icon } from "./Icons.jsx";

const PER_PAGE = 3;

function metaLine(b) {
  return (
    `${labelForKey(b.day)} · ${toHHMM(b.start_min)}` +
    (b.client_name ? ` · ${b.client_name}` : "") +
    (b.client_username ? ` · @${b.client_username}` : "")
  );
}

/**
 * Отмены клиентов из мини-аппа (cancel_own_booking в schema.sql), которые
 * мастер ещё не видела. Окно уже свободно — «Понятно» только убирает
 * карточку (cancel_seen).
 */
function Cancellations({ cancellations, busy, busyThen, onError }) {
  const ack = (id) => {
    busyThen(`ack-${id}`, 250, async () => {
      const res = await ackCancellation(id);
      if (!res.ok) onError(res.error);
    });
  };

  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Отмены</p>
        <span className="section-head-note">{cancellations.length}</span>
      </div>
      <div className="requests-list">
        {cancellations.map((b) => (
          <div className="request-card" key={b.id}>
            <div className="request-head">
              <p className="request-name">{b.service_name}</p>
              <span className="request-price">{b.price} ₾</span>
            </div>
            <p className="request-meta">{metaLine(b)}</p>
            <p className="request-comment">Клиент отменил запись — время снова свободно.</p>
            <div className="request-actions">
              <button
                className="btn-approve"
                type="button"
                disabled={!!busy}
                onClick={() => ack(b.id)}
              >
                {busy === `ack-${b.id}` && <span className="btn-spinner" aria-hidden="true" />}
                Понятно
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Новые заявки — те, что мастер ещё не подтвердила (status "new") и
 * которые ещё не прошли. «Отклонить» у заявки из мини-аппа — status
 * "cancelled" (cancelBooking в api.js): клиент увидит «Отменена
 * мастером» в «Мои записи». Клиенту с Telegram-логином после решения
 * открывается чат с сообщением (notifyClient в messages.js).
 */
export default function RequestsSection({
  bookings,
  cancellations,
  masterName,
  busy,
  busyThen,
  onToast,
  onError,
  onEdit,
}) {
  const [page, setPage] = useState(0);

  const pending = useMemo(
    () =>
      bookings
        .filter((b) => b.status === "new" && !isBookingPast(b))
        .sort((a, b) => a.day.localeCompare(b.day) || a.start_min - b.start_min),
    [bookings]
  );

  const cancelList =
    cancellations.length > 0 ? (
      <Cancellations
        cancellations={cancellations}
        busy={busy}
        busyThen={busyThen}
        onError={onError}
      />
    ) : null;

  if (pending.length === 0) {
    return (
      <>
        {cancelList}
        <div className="blank tall">Новых заявок нет</div>
      </>
    );
  }

  const pages = Math.max(1, Math.ceil(pending.length / PER_PAGE));
  const cur = Math.min(page, pages - 1);
  const from = cur * PER_PAGE;
  const shown = pending.slice(from, from + PER_PAGE);

  // Клиенту из мини-аппа с логином — сразу чат с готовым сообщением
  // (notifyClient, уже после записи в базу: чат обычно закрывает
  // кабинет). Без логина он узнает о решении сам (src/sync.js); прочим
  // мастер пишет в чат.
  const told = (b, kind, done) =>
    notifyClient(b, kind, masterName)
      ? `${done} — открываем чат с клиентом.`
      : clientSeesStatus(b)
        ? `${done} — клиент увидит это в «Мои записи».`
        : `${done}. Напишите клиенту в чате.`;

  const approve = (b) => {
    busyThen(`appr-${b.id}`, 500, async () => {
      const res = await approveBooking(b.id);
      if (res.ok) onToast(told(b, "approved", "Запись подтверждена"));
      else onError(res.error);
    });
  };

  const decline = (b) => {
    busyThen(`drop-${b.id}`, 450, async () => {
      const res = await cancelBooking(b);
      if (res.ok) onToast(told(b, "declined", "Заявка отклонена"));
      else onError(res.error);
    });
  };

  return (
    <div>
      {cancelList}

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
              <p className="request-meta">{metaLine(b)}</p>
              {b.comment ? <p className="request-comment">«{b.comment}»</p> : null}
              <div className="request-actions">
                <button
                  className="btn-approve"
                  type="button"
                  disabled={!!busy}
                  onClick={() => approve(b)}
                >
                  {approving && <span className="btn-spinner" aria-hidden="true" />}
                  {approving ? "Подтверждаем" : "Подтвердить"}
                </button>
                <button
                  className="btn-edit"
                  type="button"
                  disabled={!!busy}
                  onClick={() => onEdit(b.id)}
                >
                  Изменить
                </button>
                <button
                  className="btn-decline"
                  type="button"
                  disabled={!!busy}
                  onClick={() => decline(b)}
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
