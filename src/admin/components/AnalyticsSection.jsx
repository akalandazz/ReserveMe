import { useMemo, useState } from "react";
import { CURRENCY, formatAmount, formatPrice } from "../../money.js";
import { toHHMM } from "../../schedule.js";
import {
  PRESETS,
  analyticsFor,
  deltaLabel,
  monthEntries,
  monthTitle,
  monthTotals,
  presetOf,
  presetRange,
  rangeLabel,
  sumPrice,
} from "../analytics.js";
import {
  pluralBookings,
  pluralClients,
  pluralVisits,
  relativeVisit,
  shortDate,
} from "../calendar.js";
import { contactLink, monogram } from "../contact.js";
import { Icon } from "./Icons.jsx";
import RangePicker from "./RangePicker.jsx";

// Высота самого высокого столбика, px; пустой месяц — тонкая черта.
const BAR_MAX = 60;

const visitsLabel = (n) => `${n} ${pluralVisits(n)}`;
const lastLabel = (day) => (day ? `была ${relativeVisit(day)}` : "ещё не была");
const periodText = (range) => (range.from || range.to ? `за ${rangeLabel(range)}` : "за всё время");

/**
 * «Аналитика» за выбранный период (по умолчанию — этот месяц; быстрый
 * выбор или свои даты): заработано на визитах и ожидается от
 * подтверждённых будущих записей, шесть месяцев столбиками с историей
 * месяца по тапу, популярные услуги, постоянные клиенты и те, кто
 * приходит редко. Всё считается в analytics.js из уже загруженных записей.
 *
 * onOpenClient(id) — раскрыть карточку в «Клиентах»; onBook(id) — лист
 * «Новая запись» с этим клиентом.
 */
export default function AnalyticsSection({ bookings, clients, onOpenClient, onBook }) {
  const [range, setRange] = useState(() => presetRange("month"));
  const [picking, setPicking] = useState(false);
  const [month, setMonth] = useState(null);

  const a = useMemo(
    () => analyticsFor({ bookings, clients, from: range.from, to: range.to }),
    [bookings, clients, range]
  );
  const months = useMemo(() => monthTotals(bookings), [bookings]);
  const maxMonth = Math.max(0, ...months.map((m) => m.earned + m.expected));
  const opened = useMemo(() => (month ? monthEntries(bookings, month) : []), [bookings, month]);
  const openedDone = opened.filter((b) => !b.upcoming);
  const openedAhead = opened.filter((b) => b.upcoming);

  const preset = presetOf(range);
  const label = periodText(range);
  const delta = deltaLabel(a.delta);

  const choose = (next) => {
    setRange(next);
    setPicking(false);
  };

  return (
    <div className="analytics">
      <div className="header-row">
        <h1 className="title">Аналитика</h1>
        <span className="header-name">{label}</span>
      </div>

      <div className="view-toggle an-periods" role="group" aria-label="Период">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="view-btn"
            aria-pressed={!picking && preset === p.id ? "true" : "false"}
            onClick={() => choose(presetRange(p.id))}
          >
            {p.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="link-btn an-custom-btn"
        aria-expanded={picking ? "true" : "false"}
        data-active={!preset ? "true" : "false"}
        onClick={() => setPicking((v) => !v)}
      >
        <Icon name="calendar" size={14} />
        {preset ? "Свои даты" : `Свои даты: ${rangeLabel(range)}`}
      </button>

      {picking && (
        <RangePicker
          from={range.from}
          to={range.to}
          onApply={choose}
          onReset={() => choose(presetRange("month"))}
        />
      )}

      <div className="an-card">
        <div className="an-split">
          <div className="an-figure">
            <p className="an-kicker">Заработано</p>
            <span className="an-revenue">{formatPrice(a.earned)}</span>
            <span className="an-figure-sub">{visitsLabel(a.visitCount)}</span>
          </div>
          <div className="an-figure is-expected">
            <p className="an-kicker">Ожидается</p>
            <span className="an-revenue">{formatPrice(a.expected)}</span>
            <span className="an-figure-sub">
              {a.upcomingCount} {pluralBookings(a.upcomingCount)} впереди
            </span>
          </div>
        </div>
        <p className="an-total">
          Итого за период: <span className="an-money">{formatPrice(a.total)}</span>
          {delta && <span className="an-delta"> · {delta}</span>}
        </p>

        <p className="an-kicker an-chart-title">По месяцам, {CURRENCY}</p>
        <div className="an-chart">
          {months.map((m) => {
            const on = month === m.mk;
            const strong = month ? on : m.current;
            const sum = m.earned + m.expected;
            const h = sum ? Math.max(4, Math.round((sum / maxMonth) * BAR_MAX)) : 2;
            const hExpected = sum ? Math.round((h * m.expected) / sum) : 0;
            return (
              <button
                key={m.mk}
                type="button"
                className="an-col"
                data-strong={strong ? "true" : "false"}
                aria-pressed={on ? "true" : "false"}
                aria-label={`${monthTitle(m.mk)}: заработано ${formatPrice(m.earned)}${
                  m.expected ? `, ожидается ${formatPrice(m.expected)}` : ""
                }`}
                onClick={() => setMonth(on ? null : m.mk)}
              >
                <span className="an-col-value">{sum ? formatAmount(sum) : "—"}</span>
                <span className="an-col-bar" style={{ height: `${h}px` }}>
                  {hExpected > 0 && (
                    <span className="an-col-expected" style={{ height: `${hExpected}px` }} />
                  )}
                </span>
                <span className="an-col-label">{m.label}</span>
              </button>
            );
          })}
        </div>
        {months.some((m) => m.expected) && (
          <div className="an-legend" aria-hidden="true">
            <span className="an-legend-item">
              <span className="an-legend-box" />
              заработано
            </span>
            <span className="an-legend-item">
              <span className="an-legend-box is-expected" />
              ожидается
            </span>
          </div>
        )}

        {month ? (
          <div className="an-month">
            <div className="an-month-head">
              <span className="an-month-title">{monthTitle(month)}</span>
              <button type="button" className="link-btn an-month-close" onClick={() => setMonth(null)}>
                Скрыть
              </button>
            </div>
            <p className="an-month-sub">
              {visitsLabel(openedDone.length)} · {formatPrice(sumPrice(openedDone))}
              {openedAhead.length > 0 && ` · ожидается ${formatPrice(sumPrice(openedAhead))}`}
            </p>
            <div className="an-month-list">
              {opened.length === 0 ? (
                <p className="an-month-empty">В этом месяце визитов не было</p>
              ) : (
                opened.map((b) => (
                  <div className="an-month-row" key={b.id} data-upcoming={b.upcoming ? "true" : "false"}>
                    <span className="an-month-when">
                      <span>{shortDate(b.day)}</span>
                      <span>{toHHMM(b.start_min)}</span>
                    </span>
                    <span className="an-month-main">
                      <span className="an-month-name">
                        {b.client_name || "Клиент"}
                        {b.upcoming && <span className="visit-tag">впереди</span>}
                      </span>
                      <span className="an-month-service">{b.service_name || "Услуга"}</span>
                    </span>
                    <span className="an-money">{formatPrice(b.price)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <p className="an-hint">Нажмите на месяц, чтобы увидеть визиты</p>
        )}
      </div>

      <div className="stats-grid an-tiles">
        <div className="stat-tile">
          <span className="stat-value">{a.visitCount}</span>
          <span className="stat-label">Визитов</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{a.upcomingCount}</span>
          <span className="stat-label">Впереди</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{a.avg == null ? "—" : formatPrice(Math.round(a.avg))}</span>
          <span className="stat-label">Средний чек</span>
        </div>
      </div>

      <p className="eyebrow an-eyebrow">Популярные услуги</p>
      <div className="an-panel">
        {a.services.length === 0 ? (
          <p className="an-empty">За этот период визитов не было</p>
        ) : (
          a.services.map((s) => (
            <div className="an-svc" key={s.id}>
              <div className="an-svc-head">
                <span className="an-svc-name">{s.name}</span>
                <span className="an-money lg">{formatPrice(s.sum)}</span>
              </div>
              <div className="an-svc-track">
                <div
                  className="an-svc-fill"
                  style={{ width: `${Math.max(4, Math.round((s.visits / a.services[0].visits) * 100))}%` }}
                />
              </div>
              <p className="an-svc-meta">
                {visitsLabel(s.visits)} · {Math.round((s.visits / a.visitCount) * 100)}% всех визитов
              </p>
            </div>
          ))
        )}
      </div>

      <div className="section-head an-section-head">
        <span className="eyebrow">Постоянные клиенты</span>
        {a.clientCount > 0 && (
          <span className="section-head-note">
            {a.clientCount} {pluralClients(a.clientCount)} с визитами
          </span>
        )}
      </div>
      <div className="an-panel">
        {a.top.length === 0 ? (
          <p className="an-empty">За этот период визитов не было</p>
        ) : (
          a.top.map((t, i) => (
            <button
              type="button"
              className="an-client an-top"
              key={t.client.id}
              onClick={() => onOpenClient(t.client.id)}
            >
              <span className="an-rank">{i + 1}</span>
              <span className="client-monogram">{monogram(t.client.name)}</span>
              <span className="an-client-main">
                <span className="an-client-name">{t.client.name || "Без имени"}</span>
                <span className="an-client-meta">
                  {visitsLabel(t.visits)} · {lastLabel(t.lastVisit)}
                </span>
              </span>
              <span className="an-money lg">{formatPrice(t.sum)}</span>
            </button>
          ))
        )}
      </div>

      <div className="section-head an-section-head">
        <span className="eyebrow">Редко приходят</span>
        <span className="section-head-note">стоит написать</span>
      </div>
      <div className="an-panel">
        {a.rare.length === 0 ? (
          <p className="an-empty">Пока некого показать</p>
        ) : (
          a.rare.map((r) => {
            const link = contactLink(r.client);
            return (
              <div className="an-client an-rare" key={r.client.id}>
                <button
                  type="button"
                  className="an-rare-open"
                  onClick={() => onOpenClient(r.client.id)}
                >
                  <span className="client-monogram is-muted">{monogram(r.client.name)}</span>
                  <span className="an-client-main">
                    <span className="an-client-name">{r.client.name || "Без имени"}</span>
                    <span className="an-client-meta">
                      {visitsLabel(r.visits)} · {lastLabel(r.lastVisit)}
                    </span>
                    {r.next ? (
                      <span className="an-client-meta">
                        Запись: {shortDate(r.next.day)}, {toHHMM(r.next.start_min)}
                      </span>
                    ) : (
                      <span className="an-client-meta is-danger">Нет будущей записи</span>
                    )}
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
                <button type="button" className="an-book" onClick={() => onBook(r.client.id)}>
                  Записать
                </button>
              </div>
            );
          })
        )}
        <p className="an-note">
          Клиенты с наименьшим числом визитов {label}; сначала те, кто не был дольше всех.
        </p>
      </div>
    </div>
  );
}
