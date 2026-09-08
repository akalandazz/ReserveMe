import { useMemo, useState } from "react";
import { labelForKey, toHHMM } from "../../schedule.js";
import { updateClient } from "../api.js";
import { isBookingPast, pluralVisits, relativeVisit } from "../calendar.js";
import { Icon } from "./Icons.jsx";

const MODES = [
  { id: "day", label: "За день" },
  { id: "all", label: "Все" },
];

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

export default function ClientsSection({
  clients,
  bookings,
  selectedKey,
  busy,
  busyThen,
  onToast,
  onError,
}) {
  const [mode, setMode] = useState("day");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [draft, setDraft] = useState({ phone: "", note: "" });

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

  const startEdit = (c) => {
    setDraft({ phone: c.phone || "", note: c.note || "" });
    setEditId(c.id);
  };

  const saveEdit = (id) => {
    busyThen(`client-${id}`, 400, async () => {
      const res = await updateClient(id, draft);
      if (res.ok) onToast("Данные клиента сохранены.");
      else onError(res.error);
      setEditId(null);
    });
  };

  const emptyText =
    mode === "day"
      ? "На этот день записей нет"
      : query.trim()
        ? "Никого не нашлось"
        : "Клиентов пока нет";

  return (
    <div>
      <div className="header-row">
        <h1 className="title">Клиенты</h1>
        <span className="header-name">
          {mode === "day" ? labelForKey(selectedKey) : `${clients.length} всего`}
        </span>
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

      {filtered.length === 0 ? (
        <div className="blank tall">{emptyText}</div>
      ) : (
        <div className="clients-panel">
          {filtered.map((c) => {
            const expanded = openId === c.id;
            const editing = editId === c.id;
            const saving = busy === `client-${c.id}`;
            const next = expanded ? nextBookingFor(bookings, c.id) : null;

            const subtitle =
              mode === "day"
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
                    onClick={() => setOpenId(expanded ? null : c.id)}
                  >
                    <span className="client-monogram">{monogram(c.name)}</span>
                    <span className="client-main">
                      <span className="client-name">{c.name || "Без имени"}</span>
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
                        <label className="eyebrow" htmlFor={`client-phone-${c.id}`}>
                          Телефон
                        </label>
                        <input
                          id={`client-phone-${c.id}`}
                          type="tel"
                          className="field"
                          value={draft.phone}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, phone: e.target.value }))
                          }
                        />
                        <label className="eyebrow" htmlFor={`client-note-${c.id}`}>
                          Заметка
                        </label>
                        <textarea
                          id={`client-note-${c.id}`}
                          className="field"
                          rows={3}
                          value={draft.note}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, note: e.target.value }))
                          }
                        />
                        <div className="client-edit-actions">
                          <button
                            className="btn-cancel-draft"
                            type="button"
                            onClick={() => setEditId(null)}
                          >
                            Отменить
                          </button>
                          <button
                            className="btn-save"
                            type="button"
                            disabled={saving}
                            onClick={() => saveEdit(c.id)}
                          >
                            {saving && <span className="btn-spinner" aria-hidden="true" />}
                            {saving ? "Сохраняем" : "Сохранить"}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="client-detail-row">
                          {c.phone || "Телефон не указан"}
                        </p>
                        <p className="client-detail-row">
                          {c.favorite_service_name || "Услуга ещё не выбрана"}
                        </p>
                        <p className="client-detail-row">
                          {next
                            ? `Ближайшая запись: ${labelForKey(next.day)}, ${toHHMM(next.start_min)}`
                            : "Записей пока нет"}
                        </p>
                        {c.note && <div className="client-note-box">{c.note}</div>}
                        <button
                          className="link-btn"
                          type="button"
                          onClick={() => startEdit(c)}
                        >
                          Изменить
                        </button>
                        {c.telegram_username && (
                          <a
                            className="btn-primary inline"
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
