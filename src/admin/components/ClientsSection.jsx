import { useMemo, useState } from "react";
import { labelForKey, toHHMM } from "../../schedule.js";
import { addClientComment, createClient, deleteClientComment, updateClient } from "../api.js";
import {
  commentDate,
  isBookingPast,
  pluralVisits,
  relativeVisit,
  shortDate,
} from "../calendar.js";
import { Icon } from "./Icons.jsx";

const MODES = [
  { id: "day", label: "За день" },
  { id: "all", label: "Все" },
];

// Ещё не сохранённый клиент из «Новый клиент» — живёт только здесь,
// в базу попадает по «Сохранить». «Отмена» просто убирает его.
const NEW_ID = "new";
const NEW_CLIENT = { id: NEW_ID, name: "", telegram_username: "", phone: "", visit_count: 0 };
const EMPTY_DRAFT = { name: "", telegram_username: "", phone: "" };
const VISITS_PREVIEW = 3;

function monogram(name) {
  return (name || "").trim().charAt(0).toUpperCase() || "?";
}

function telegramUrl(username) {
  return `https://t.me/${username}`;
}

/**
 * Ближайшая ещё не прошедшая запись клиента — от режима «За
 * день»/«Все» не зависит: список всех записей уже загружен целиком
 * (см. store.js), лишний запрос не нужен.
 */
function nextBookingFor(bookings, clientId) {
  return bookings
    .filter((b) => b.client_id === clientId && !isBookingPast(b))
    .sort((a, b) => a.day.localeCompare(b.day) || a.start_min - b.start_min)[0] ?? null;
}

/** Прошедшие записи клиента, новые сверху — те же, что считает visit_count. */
function pastBookingsFor(bookings, clientId) {
  return bookings
    .filter((b) => b.client_id === clientId && isBookingPast(b))
    .sort((a, b) => b.day.localeCompare(a.day) || b.start_min - a.start_min);
}

export default function ClientsSection({
  clients,
  comments,
  bookings,
  selectedKey,
  busy,
  busyThen,
  onToast,
  onError,
  onBook,
}) {
  const [mode, setMode] = useState("day");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [pendingNew, setPendingNew] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [allVisits, setAllVisits] = useState(false);

  const dayRows = useMemo(() => {
    const seen = new Set();
    const rows = [];
    for (const b of bookings) {
      if (b.day !== selectedKey || !b.client_id || seen.has(b.client_id)) continue;
      const c = clients.find((x) => x.id === b.client_id);
      if (!c) continue;
      seen.add(b.client_id);
      rows.push({ ...c, dayTime: toHHMM(b.start_min), dayService: b.service_name });
    }
    return rows;
  }, [bookings, clients, selectedKey]);

  const base = mode === "day" ? dayRows : clients;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((c) =>
      [c.name, c.telegram_username, c.phone, c.favorite_service_name]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    );
  }, [base, query]);

  const rows = pendingNew ? [NEW_CLIENT, ...filtered] : filtered;

  const commentsByClient = useMemo(() => {
    const map = new Map();
    for (const cm of comments) {
      if (!map.has(cm.client_id)) map.set(cm.client_id, []);
      map.get(cm.client_id).push(cm); // уже новые сверху — см. store.js
    }
    return map;
  }, [comments]);

  const toggleOpen = (id) => {
    const next = openId === id ? null : id;
    setOpenId(next);
    setEditId(null);
    setCommentText("");
    setAllVisits(false);
    // Несохранённый новый клиент исчезает, как только мастер ушла из него.
    if (pendingNew && next !== NEW_ID) setPendingNew(false);
  };

  const addNew = () => {
    setMode("all");
    setQuery("");
    setPendingNew(true);
    setOpenId(NEW_ID);
    setEditId(NEW_ID);
    setDraft(EMPTY_DRAFT);
    setCommentText("");
  };

  const startEdit = (c) => {
    setDraft({
      name: c.name || "",
      telegram_username: c.telegram_username || "",
      phone: c.phone || "",
    });
    setEditId(c.id);
  };

  const cancelEdit = () => {
    if (editId === NEW_ID) {
      setPendingNew(false);
      setOpenId(null);
    }
    setEditId(null);
  };

  const saveEdit = (c) => {
    if (!draft.name.trim()) {
      onToast("Укажите имя клиента.");
      return;
    }
    const isNew = c.id === NEW_ID;
    busyThen(`client-${c.id}`, 400, async () => {
      const res = isNew ? await createClient(draft) : await updateClient(c.id, draft);
      if (!res.ok) {
        onError(res.error);
        return;
      }
      onToast("Данные клиента сохранены.");
      setEditId(null);
      if (isNew) {
        setPendingNew(false);
        setOpenId(res.id);
      }
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

  const emptyText =
    mode === "day"
      ? "На этот день записей нет"
      : query.trim()
        ? "Никого не нашлось"
        : "Клиентов пока нет";

  const field = (c, key, label, type = "text") => (
    <>
      <label className="eyebrow" htmlFor={`client-${key}-${c.id}`}>
        {label}
      </label>
      <input
        id={`client-${key}-${c.id}`}
        type={type}
        className="field"
        autoComplete="off"
        value={draft[key]}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
      />
    </>
  );

  return (
    <div>
      <div className="header-row">
        <div className="header-stack">
          <h1 className="title">Клиенты</h1>
          <span className="header-name">
            {mode === "day" ? labelForKey(selectedKey) : `${clients.length} всего`}
          </span>
        </div>
        <button className="pill-btn has-icon" type="button" onClick={addNew}>
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
              onClick={() => setMode(m.id)}
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
            const isNew = c.id === NEW_ID;
            const expanded = openId === c.id;
            const editing = editId === c.id;
            const saving = busy === `client-${c.id}`;
            const next = expanded && !isNew ? nextBookingFor(bookings, c.id) : null;
            const past = expanded && !isNew ? pastBookingsFor(bookings, c.id) : [];
            const shownPast = allVisits ? past : past.slice(0, VISITS_PREVIEW);
            const notes = commentsByClient.get(c.id) ?? [];

            const subtitle = isNew
              ? "Заполните данные клиента"
              : mode === "day"
                ? [c.dayTime, c.dayService].filter(Boolean).join(" · ")
                : [
                    c.telegram_username && `@${c.telegram_username}`,
                    `${c.visit_count} ${pluralVisits(c.visit_count)}`,
                    c.last_visit_at && `была ${relativeVisit(c.last_visit_at)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ");

            return (
              <div
                className="client-row"
                key={c.id}
                data-expanded={expanded ? "true" : "false"}
              >
                <div className="client-row-top">
                  <button
                    type="button"
                    className="client-row-head"
                    onClick={() => toggleOpen(c.id)}
                  >
                    <span className="client-monogram">{monogram(c.name)}</span>
                    <span className="client-main">
                      <span className="client-name">
                        {isNew ? "Новый клиент" : c.name || "Без имени"}
                      </span>
                      {subtitle && <span className="client-sub">{subtitle}</span>}
                    </span>
                  </button>
                  {c.telegram_username && (
                    <a
                      className="round-btn"
                      href={telegramUrl(c.telegram_username)}
                      target="_blank"
                      rel="noopener"
                      aria-label="Написать в Telegram"
                    >
                      <Icon name="telegram" size={15} />
                    </a>
                  )}
                </div>

                {expanded && (
                  <div className="client-detail">
                    {editing ? (
                      <>
                        {field(c, "name", "Имя")}
                        {field(c, "telegram_username", "Telegram")}
                        {field(c, "phone", "Телефон", "tel")}
                        <div className="client-edit-actions">
                          <button className="btn-cancel-draft" type="button" onClick={cancelEdit}>
                            Отмена
                          </button>
                          <button
                            className="btn-save"
                            type="button"
                            disabled={saving}
                            onClick={() => saveEdit(c)}
                          >
                            {saving && <span className="btn-spinner" aria-hidden="true" />}
                            {saving ? "Сохраняем" : "Сохранить"}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="client-actions">
                          <button className="btn-save" type="button" onClick={() => onBook(c.id)}>
                            Записать
                          </button>
                          <button className="btn-outline" type="button" onClick={() => startEdit(c)}>
                            Изменить
                          </button>
                        </div>

                        <dl className="client-info">
                          <div>
                            <dt className="client-label">Телефон</dt>
                            <dd>{c.phone || "Не указан"}</dd>
                          </div>
                          <div>
                            <dt className="client-label">Чаще всего</dt>
                            <dd>{c.favorite_service_name || "—"}</dd>
                          </div>
                          <div>
                            <dt className="client-label">Ближайшая запись</dt>
                            <dd>
                              {next
                                ? `${labelForKey(next.day)}, ${toHHMM(next.start_min)}`
                                : "Не запланирована"}
                            </dd>
                          </div>
                        </dl>
                      </>
                    )}

                    {!isNew && (
                      <>
                        <p className="client-label client-section">Комментарии</p>
                        {notes.length > 0 && (
                          <ul className="comment-list">
                            {notes.map((cm) => (
                              <li className="comment" key={cm.id}>
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
                              </li>
                            ))}
                          </ul>
                        )}
                        <textarea
                          className="field comment-input"
                          rows={2}
                          placeholder="Написать комментарий…"
                          aria-label="Новый комментарий"
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                        />
                        <button
                          className="btn-save comment-add"
                          type="button"
                          disabled={!commentText.trim() || busy === "comment-add"}
                          onClick={() => addComment(c.id)}
                        >
                          {busy === "comment-add" && (
                            <span className="btn-spinner" aria-hidden="true" />
                          )}
                          Добавить
                        </button>

                        <p className="client-label client-section">
                          Прошлые записи · {past.length}
                        </p>
                        <div className="visits-box">
                          {past.length === 0 ? (
                            <p className="visits-empty">Ещё не было визитов</p>
                          ) : (
                            shownPast.map((b) => (
                              <div className="visit-row" key={b.id}>
                                <span className="visit-date">{shortDate(b.day)}</span>
                                <span className="visit-service">{b.service_name}</span>
                                <span className="visit-price">{b.price} ₾</span>
                              </div>
                            ))
                          )}
                          {past.length > VISITS_PREVIEW && (
                            <button
                              className="link-btn visits-toggle"
                              type="button"
                              onClick={() => setAllVisits((v) => !v)}
                            >
                              {allVisits ? "Свернуть" : `Показать все ${past.length}`}
                            </button>
                          )}
                        </div>

                        {c.telegram_username && (
                          <a
                            className="client-tg-link"
                            href={telegramUrl(c.telegram_username)}
                            target="_blank"
                            rel="noopener"
                          >
                            Написать в Telegram
                          </a>
                        )}
                      </>
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
