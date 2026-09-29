import { Fragment, useMemo, useState } from "react";
import { labelForKey, toHHMM } from "../../schedule.js";
import { CHANNELS, addClientComment, deleteClient, deleteClientComment } from "../api.js";
import {
  commentDate,
  isBookingPast,
  pluralBookings,
  pluralComments,
  pluralVisits,
  relativeVisit,
  shortDate,
} from "../calendar.js";
import { Icon } from "./Icons.jsx";

const MODES = [
  { id: "day", label: "За день" },
  { id: "all", label: "Все" },
];

const VISITS_PREVIEW = 3;

function monogram(name) {
  return (name || "").trim().charAt(0).toUpperCase() || "?";
}

const channelLabel = (id) => CHANNELS.find((c) => c.id === id)?.label ?? "";

/** Куда ведёт круглая кнопка в строке: Telegram, WhatsApp или звонок. */
function contactLink(c) {
  if (c.telegram_username) {
    return {
      href: `https://t.me/${c.telegram_username}`,
      label: "Написать в Telegram",
      icon: "telegram",
    };
  }
  const phone = String(c.phone || "").replace(/[^\d+]/g, "");
  if (!phone) return null;
  if (c.channel === "wa") {
    return {
      href: `https://wa.me/${phone.replace(/\D/g, "")}`,
      label: "Написать в WhatsApp",
      icon: "chat",
    };
  }
  return { href: `tel:${phone}`, label: "Позвонить", icon: "phone" };
}

/** Все ещё не прошедшие записи и заявки клиента, ближайшие сверху. */
function upcomingBookingsFor(bookings, clientId) {
  return bookings
    .filter((b) => b.client_id === clientId && !isBookingPast(b))
    .sort((a, b) => a.day.localeCompare(b.day) || a.start_min - b.start_min);
}

/** Прошедшие записи клиента, новые сверху — те же, что считает visit_count. */
function pastBookingsFor(bookings, clientId) {
  return bookings
    .filter((b) => b.client_id === clientId && isBookingPast(b))
    .sort((a, b) => b.day.localeCompare(a.day) || b.start_min - a.start_min);
}

/**
 * «Клиенты». Данные клиента здесь не правятся — «Изменить» открывает
 * лист записи (BookingSheet): ближайшую запись клиента, если она есть
 * (там же и данные клиента), иначе — лист только с клиентом. Тем же
 * листом заводится «Новый клиент»; после сохранения AdminApp передаёт
 * его id в focus, и мы раскрываем его в «Все».
 */
export default function ClientsSection({
  clients,
  comments,
  bookings,
  selectedKey,
  focus,
  busy,
  busyThen,
  onToast,
  onError,
  onBook,
  onEditBooking,
  onEditClient,
  confirmDel,
  setConfirmDel,
  onDeleteBooking,
  onClientDeleted,
}) {
  const [mode, setMode] = useState("day");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(null);
  const [commentText, setCommentText] = useState("");
  const [allVisits, setAllVisits] = useState(false);

  // Новый focus — раскрыть этого клиента. Сравнение во время рендера,
  // а не эффект: иначе на кадр мелькнул бы старый список.
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    if (focus) {
      setMode("all");
      setQuery("");
      setOpenId(focus.id);
      setCommentText("");
      setAllVisits(false);
    }
  }

  // Одна строка на клиента, но в подписи — все его записи за день.
  const dayRows = useMemo(() => {
    const byClient = new Map();
    for (const b of bookings) {
      if (b.day !== selectedKey || !b.client_id) continue;
      if (!byClient.has(b.client_id)) byClient.set(b.client_id, []);
      byClient.get(b.client_id).push(b);
    }
    const rows = [];
    for (const [clientId, list] of byClient) {
      const c = clients.find((x) => x.id === clientId);
      if (!c) continue;
      const dayBookings = list
        .sort((a, b) => a.start_min - b.start_min)
        .map((b) => [toHHMM(b.start_min), b.service_name].filter(Boolean).join(" "))
        .join(", ");
      rows.push({ ...c, dayBookings });
    }
    return rows;
  }, [bookings, clients, selectedKey]);

  const base = mode === "day" ? dayRows : clients;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((c) =>
      [c.name, c.telegram_username, c.phone, c.favorite_service_name]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    );
  }, [base, query]);

  const commentsByClient = useMemo(() => {
    const map = new Map();
    for (const cm of comments) {
      if (!map.has(cm.client_id)) map.set(cm.client_id, []);
      map.get(cm.client_id).push(cm); // уже новые сверху — см. store.js
    }
    return map;
  }, [comments]);

  const toggleOpen = (id) => {
    setOpenId((cur) => (cur === id ? null : id));
    setCommentText("");
    setAllVisits(false);
    setConfirmDel(null);
  };

  const isConfirming = (kind, id) => confirmDel?.kind === kind && confirmDel.id === id;
  // Повторный тап по той же корзине — закрыть своё подтверждение.
  const askDelete = (kind, id) => setConfirmDel(isConfirming(kind, id) ? null : { kind, id });

  // Клиент целиком: карточка, все записи (и будущие, и заявки) и
  // комментарии — одной транзакцией на сервере (delete_client).
  const removeClient = (c) => {
    const bookingIds = bookings.filter((b) => b.client_id === c.id).map((b) => b.id);
    busyThen(`del-client-${c.id}`, 250, async () => {
      const res = await deleteClient(c.id);
      if (!res.ok) {
        onError(res.error);
        return;
      }
      setOpenId((cur) => (cur === c.id ? null : cur));
      setCommentText("");
      setAllVisits(false);
      onClientDeleted(c.id, bookingIds);
      onToast(
        c.name
          ? `${c.name} удалена вместе со всеми записями.`
          : "Клиент удалён вместе со всеми записями."
      );
    });
  };

  const addComment = (clientId) => {
    const text = commentText.trim();
    if (!text) return;
    busyThen("comment-add", 250, async () => {
      const res = await addClientComment(clientId, text);
      if (res.ok) setCommentText("");
      else onError(res.error);
    });
  };

  const removeComment = (id) => {
    busyThen(`comment-${id}`, 250, async () => {
      const res = await deleteClientComment(id);
      if (!res.ok) onError(res.error);
    });
  };

  // Строка записи в карточке клиента. Предстоящая открывается в листе
  // записи по тапу; корзина — та же, что в панели дня (removeBooking).
  const visitRow = (b, upcoming) => (
    <Fragment key={b.id}>
      <div className="visit-row">
        <span className="visit-date">{shortDate(b.day)}</span>
        {upcoming ? (
          <button type="button" className="visit-service visit-open" onClick={() => onEditBooking(b.id)}>
            {toHHMM(b.start_min)} · {b.service_name}
            {b.status === "new" && <span className="visit-tag">заявка</span>}
          </button>
        ) : (
          <span className="visit-service">{b.service_name}</span>
        )}
        <span className="visit-price">{b.price} ₾</span>
        <button
          className="visit-del"
          type="button"
          aria-label="Удалить запись"
          aria-expanded={isConfirming("booking", b.id) ? "true" : "false"}
          onClick={() => askDelete("booking", b.id)}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
      {isConfirming("booking", b.id) && (
        <div className="del-confirm is-dense" role="group" aria-label="Удаление записи">
          <span className="del-confirm-text">Удалить запись?</span>
          <span className="del-confirm-actions">
            <button
              className="btn-danger-fill"
              type="button"
              disabled={!!busy}
              onClick={() => onDeleteBooking(b.id)}
            >
              {busy === `del-booking-${b.id}` && <span className="btn-spinner" aria-hidden="true" />}
              Удалить
            </button>
            <button className="btn-outline" type="button" onClick={() => setConfirmDel(null)}>
              Нет
            </button>
          </span>
        </div>
      )}
    </Fragment>
  );

  const emptyText =
    mode === "day"
      ? "На этот день записей нет"
      : query.trim()
        ? "Никого не нашлось"
        : "Клиентов пока нет";

  return (
    <div>
      <div className="header-row">
        <div className="header-stack">
          <h1 className="title">Клиенты</h1>
          <span className="header-name">
            {mode === "day" ? labelForKey(selectedKey) : `${clients.length} всего`}
          </span>
        </div>
        <button className="pill-btn has-icon" type="button" onClick={() => onEditClient(null)}>
          <Icon name="plus" size={14} />
          Новый клиент
        </button>
      </div>

      <div className="clients-controls">
        <div className="view-toggle">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="view-btn"
              aria-pressed={mode === m.id ? "true" : "false"}
              onClick={() => {
                setMode(m.id);
                setOpenId(null);
                setConfirmDel(null);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <input
          type="search"
          className="field"
          placeholder="Имя, телеграм или телефон"
          aria-label="Поиск клиента"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <div className="blank tall">{emptyText}</div>
      ) : (
        <div className="clients-panel">
          {rows.map((c) => {
            const expanded = openId === c.id;
            const upcoming = expanded ? upcomingBookingsFor(bookings, c.id) : [];
            const next = upcoming[0] ?? null;
            const past = expanded ? pastBookingsFor(bookings, c.id) : [];
            const shownPast = allVisits ? past : past.slice(0, VISITS_PREVIEW);
            const notes = commentsByClient.get(c.id) ?? [];
            // Всё, что уйдёт вместе с клиентом: и прошлые, и будущие, и заявки.
            const ownBookings = expanded
              ? bookings.filter((b) => b.client_id === c.id).length
              : 0;
            const link = contactLink(c);

            const handle = c.telegram_username
              ? `@${c.telegram_username}`
              : [
                  c.phone || "без контактов",
                  c.channel && c.channel !== "tg" && channelLabel(c.channel),
                ]
                  .filter(Boolean)
                  .join(" · ");
            const subtitle = [
              handle,
              `${c.visit_count} ${pluralVisits(c.visit_count)}`,
              mode === "day"
                ? c.dayBookings
                : c.last_visit_at
                  ? `была ${relativeVisit(c.last_visit_at)}`
                  : "ещё не была",
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <div className="client-row" key={c.id} data-expanded={expanded ? "true" : "false"}>
                <div className="client-row-top">
                  <button type="button" className="client-row-head" onClick={() => toggleOpen(c.id)}>
                    <span className="client-monogram">{monogram(c.name)}</span>
                    <span className="client-main">
                      <span className="client-name">{c.name || "Без имени"}</span>
                      <span className="client-sub">{subtitle}</span>
                    </span>
                  </button>
                  {link && (
                    <a
                      className="round-btn contact-btn"
                      href={link.href}
                      target="_blank"
                      rel="noopener"
                      aria-label={link.label}
                    >
                      <Icon name={link.icon} size={16} />
                    </a>
                  )}
                </div>

                {expanded && (
                  <div className="client-detail">
                    <div className="client-facts">
                      <span>
                        Телефон: <span className="client-fact">{c.phone || "—"}</span>
                      </span>
                    </div>

                    <div className="client-actions">
                      <button className="btn-save" type="button" onClick={() => onBook(c.id)}>
                        Записать
                      </button>
                      <button
                        className="btn-outline"
                        type="button"
                        onClick={() => (next ? onEditBooking(next.id) : onEditClient(c.id))}
                      >
                        Изменить
                      </button>
                    </div>

                    <p className="client-label client-section">
                      Предстоящие записи · {upcoming.length}
                    </p>
                    <div className="visits-box">
                      {upcoming.length === 0 ? (
                        <p className="visits-empty">Нет предстоящих записей</p>
                      ) : (
                        upcoming.map((b) => visitRow(b, true))
                      )}
                    </div>

                    <p className="client-label client-section">Прошлые записи · {past.length}</p>
                    <div className="visits-box">
                      {past.length === 0 ? (
                        <p className="visits-empty">Ещё не было визитов</p>
                      ) : (
                        shownPast.map((b) => visitRow(b, false))
                      )}
                    </div>
                    {past.length > VISITS_PREVIEW && (
                      <button
                        className="link-btn visits-toggle"
                        type="button"
                        onClick={() => setAllVisits((v) => !v)}
                      >
                        {allVisits ? "Свернуть" : `Показать все ${past.length}`}
                      </button>
                    )}

                    <p className="client-label client-section">Комментарии</p>
                    <div className="comment-stack">
                      {notes.map((cm) => (
                        <div className="comment" key={cm.id}>
                          <span className="comment-main">
                            <span className="comment-text">{cm.body}</span>
                            <span className="comment-date">{commentDate(cm.created_at)}</span>
                          </span>
                          <button
                            className="comment-del"
                            type="button"
                            aria-label="Удалить комментарий"
                            disabled={!!busy}
                            onClick={() => removeComment(cm.id)}
                          >
                            <Icon name="x" size={13} />
                          </button>
                        </div>
                      ))}
                      <textarea
                        className="field comment-input"
                        rows={2}
                        placeholder="Написать комментарий…"
                        aria-label="Новый комментарий"
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                      />
                      <div className="comment-add-row">
                        <button
                          className="comment-add"
                          type="button"
                          data-ready={commentText.trim() ? "true" : "false"}
                          disabled={!commentText.trim() || busy === "comment-add"}
                          onClick={() => addComment(c.id)}
                        >
                          {busy === "comment-add" && (
                            <span className="btn-spinner" aria-hidden="true" />
                          )}
                          Добавить
                        </button>
                      </div>
                    </div>

                    {isConfirming("client", c.id) ? (
                      <div className="del-confirm client-del-box" role="group" aria-label="Удаление клиента">
                        <p className="del-confirm-text">
                          Удалить {c.name || "этого клиента"} из базы? Вместе с карточкой удалятся{" "}
                          {ownBookings} {pluralBookings(ownBookings)} (прошлые и будущие) и{" "}
                          {notes.length} {pluralComments(notes.length)}. Это нельзя отменить.
                        </p>
                        <span className="del-confirm-actions">
                          <button
                            className="btn-danger-fill"
                            type="button"
                            disabled={!!busy}
                            onClick={() => removeClient(c)}
                          >
                            {busy === `del-client-${c.id}` && (
                              <span className="btn-spinner" aria-hidden="true" />
                            )}
                            Удалить всё
                          </button>
                          <button
                            className="btn-outline"
                            type="button"
                            onClick={() => setConfirmDel(null)}
                          >
                            Оставить
                          </button>
                        </span>
                      </div>
                    ) : (
                      <button
                        className="btn-outline client-del-btn"
                        type="button"
                        onClick={() => askDelete("client", c.id)}
                      >
                        Удалить клиента
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
