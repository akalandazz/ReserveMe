import { useEffect, useState } from "react";
import { formatPrice } from "../../money.js";
import { dateKey, labelForKey, toHHMM } from "../../schedule.js";
import { copyText, openChatWith } from "../../telegram.js";
import {
  CHANNELS,
  canMessageClient,
  createClient,
  cancelBooking,
  clientSeesStatus,
  createMasterBooking,
  fetchFreeSlotCounts,
  fetchFreeSlots,
  updateClient,
  updateMasterBooking,
} from "../api.js";
import { isBookingPast, isDayClosed } from "../calendar.js";
import { clientMessage, dropKind, notifyClient } from "../messages.js";
import { Icon } from "./Icons.jsx";

// Клиент, которого заводят прямо в этом листе (в базе его ещё нет).
const NEW = "new";
const DAYS_AHEAD = 21;
const STEP_INDEX = { client: 0, service: 1, day: 2, time: 2, confirm: 3 };
const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const fDayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const channelLabel = (id) => CHANNELS.find((c) => c.id === id)?.label ?? "";
const CF_FIELDS = ["name", "phone", "telegram_username"];

function cfOf(c) {
  return {
    name: c?.name ?? "",
    phone: c?.phone ?? "",
    telegram_username: c?.telegram_username ?? "",
  };
}

function sameCf(a, b) {
  return CF_FIELDS.every((f) => String(a[f] ?? "").trim() === String(b[f] ?? "").trim());
}

/**
 * Лист записи — три режима, одна механика шагов:
 *
 *  • { kind: "new", clientId? } — «Записать»: 4 шага (клиент → услуга →
 *    день → время → проверка). Запись сразу подтверждённая и в «Заявки»
 *    не попадает.
 *  • { kind: "edit", bookingId } — «Изменить» у записи или заявки:
 *    сразу проверка, откуда можно сменить клиента, услугу, время.
 *    Сохранение заявки её же и подтверждает.
 *  • { kind: "client", clientId | null } — «Новый клиент» или
 *    «Изменить» у клиента без предстоящей записи: только данные клиента.
 *
 * Время — только с сервера (free_slots / free_slot_counts): там же его
 * перепроверяют create_master_booking и update_master_booking, так что
 * список и запись не разойдутся. Ошибки — своей строкой в листе, а не
 * тостом кабинета: тост стоит в потоке страницы, под затемнением.
 */
export default function BookingSheet({
  clients,
  services,
  bookings,
  settings,
  daysOff,
  initial,
  onClose,
  onDone,
}) {
  const active = services.filter((s) => s.active !== false);
  const findClient = (id) => clients.find((c) => c.id === id) ?? null;

  const favoriteFor = (clientId) => {
    const fav = findClient(clientId)?.favorite_service_id;
    return fav && active.some((s) => s.id === fav) ? fav : "";
  };

  const [st, setSt] = useState(() => {
    const base = {
      hist: [],
      q: "",
      newOpen: false,
      newName: "",
      newPhone: "",
      newTg: "",
      newCh: "wa",
      s: "",
      d: "",
      t: null,
      cm: "",
      copied: false,
      askCancel: false,
    };
    if (initial.kind === "client") {
      const c = initial.clientId != null ? findClient(initial.clientId) : null;
      const cf = cfOf(c);
      return { ...base, step: "confirm", c: c ? c.id : NEW, cf, cfOrig: cf };
    }
    if (initial.kind === "edit") {
      const bk = bookings.find((x) => x.id === initial.bookingId);
      const c = bk.client_id != null ? findClient(bk.client_id) : null;
      // Заявка без клиента (Telegram не отдал имени) — при сохранении
      // клиент заведётся из того, что мастер впишет в форму.
      const cf = c
        ? cfOf(c)
        : { name: bk.client_name ?? "", phone: "", telegram_username: bk.client_username ?? "" };
      const orig = {
        c: c ? c.id : NEW,
        s: bk.service_id ?? "",
        d: bk.day,
        t: bk.start_min,
        cm: bk.comment ?? "",
      };
      return { ...base, ...orig, newCh: "", step: "confirm", cf, cfOrig: cf, orig, bk };
    }
    const c = initial.clientId ?? "";
    return {
      ...base,
      step: c !== "" ? "service" : "client",
      c,
      s: c !== "" ? favoriteFor(c) : "",
    };
  });

  // { key, map } / { key, list } — key отличает свежий ответ от ответа на
  // прошлый выбор: пока они не совпали, идёт загрузка.
  const [counts, setCounts] = useState({ key: "", map: new Map() });
  const [slots, setSlots] = useState({ key: "", list: [] });
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const isEdit = initial.kind === "edit";
  const clientOnly = initial.kind === "client";
  const bk = st.bk ?? null;
  const editId = bk?.id ?? null;
  const today = dateKey(new Date());

  const patch = (p) => setSt((prev) => ({ ...prev, ...p }));
  const go = (step, p = {}) => {
    setError("");
    setSt((prev) => ({ ...prev, ...p, step, hist: [...prev.hist, prev.step], copied: false }));
  };
  const back = () => {
    setError("");
    if (!st.hist.length) {
      onClose();
      return;
    }
    setSt((prev) => ({
      ...prev,
      step: prev.hist[prev.hist.length - 1],
      hist: prev.hist.slice(0, -1),
    }));
  };

  // Услуга, как её видит клиент: у записи с той же услугой — то, что уже
  // согласовано (цена и длительность на строке), а не текущий прайс.
  const svc = services.find((s) => s.id === st.s) ?? null;
  const origView = bk ? { name: bk.service_name, duration: bk.duration, price: bk.price } : null;
  const sv = isEdit && st.s === st.orig.s ? origView : svc;

  const slotsKey = st.step === "time" && st.d && st.s ? `${st.d}|${st.s}|${editId ?? ""}` : "";
  const countsKey = st.step === "day" && st.s ? `${today}|${st.s}|${editId ?? ""}` : "";
  const slotsLoading = slotsKey !== "" && slots.key !== slotsKey;
  const countsLoading = countsKey !== "" && counts.key !== countsKey;

  useEffect(() => {
    if (!slotsKey) return;
    let cancelled = false;
    const [d, s] = slotsKey.split("|");
    fetchFreeSlots(d, s, editId).then((res) => {
      if (cancelled) return;
      if (!res.ok) setError(res.error);
      setSlots({ key: slotsKey, list: res.slots });
    });
    return () => {
      cancelled = true;
    };
  }, [slotsKey, editId]);

  useEffect(() => {
    if (!countsKey) return;
    let cancelled = false;
    const [from, s] = countsKey.split("|");
    fetchFreeSlotCounts(from, DAYS_AHEAD, s, editId).then((res) => {
      if (cancelled) return;
      if (!res.ok) setError(res.error);
      setCounts({ key: countsKey, map: res.counts });
    });
    return () => {
      cancelled = true;
    };
  }, [countsKey, editId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const client = st.c !== NEW && st.c !== "" ? findClient(st.c) : null;
  const name = (
    isEdit || clientOnly ? st.cf.name : st.c === NEW ? st.newName : (client?.name ?? "")
  ).trim();
  const channel =
    st.c === NEW ? st.newCh : client?.channel || (client?.telegram_username ? "tg" : "");

  const cfChanged = st.cf ? !sameCf(st.cf, st.cfOrig) : false;
  const slotChanged = isEdit && (st.d !== st.orig.d || st.t !== st.orig.t);
  const changed =
    isEdit &&
    (slotChanged ||
      st.s !== st.orig.s ||
      st.c !== st.orig.c ||
      st.cm.trim() !== st.orig.cm.trim() ||
      cfChanged);
  const wasNew = isEdit && bk.status === "new";
  // Клиенту из мини-аппа с логином кабинет сам откроет чат с сообщением
  // (как клиент — мастеру), но только когда для клиента что-то поменялось:
  // подтверждение, перенос, другая услуга. Логин — из формы: мастер могла
  // его поправить или сменить клиента.
  const clientTg = isEdit ? st.cf.telegram_username : "";
  const notifies =
    isEdit &&
    canMessageClient({ user_id: bk.user_id, client_username: clientTg }) &&
    (wasNew || slotChanged || st.s !== st.orig.s);
  const dirty = clientOnly ? cfChanged || st.c === NEW : !isEdit || changed || wasNew;
  const ready =
    dirty && name !== "" && (clientOnly || (st.s !== "" && st.d !== "" && st.t != null));

  /* ─── Переходы ──────────────────────────────────────────────── */

  const pickClient = (c) => {
    if (isEdit) {
      const cf = cfOf(c);
      setError("");
      patch({ step: "confirm", hist: [], c: c.id, cf, cfOrig: cf, newOpen: false });
      return;
    }
    go("service", { c: c.id, s: st.s || favoriteFor(c.id), newOpen: false });
  };

  const submitNew = () => {
    if (!st.newName.trim()) return;
    if (isEdit) {
      setError("");
      patch({
        step: "confirm",
        hist: [],
        c: NEW,
        newOpen: false,
        cf: { name: st.newName, phone: st.newPhone, telegram_username: st.newTg },
        cfOrig: { name: "", phone: "", telegram_username: "" },
      });
      return;
    }
    go("service", { c: NEW });
  };

  const pickService = async (sid) => {
    if (checking) return;
    if (!(st.d && st.t != null)) {
      go("day", { s: sid });
      return;
    }
    // Время уже выбрано — проверяем, влезает ли в него новая услуга.
    setChecking(true);
    const res = await fetchFreeSlots(st.d, sid, editId);
    setChecking(false);
    setSlots({ key: `${st.d}|${sid}|${editId ?? ""}`, list: res.slots });
    if (res.slots.includes(st.t)) go("confirm", { s: sid });
    else go("time", { s: sid, t: null });
  };

  /* ─── Сохранение ────────────────────────────────────────────── */

  const finish = (res, done) => {
    setSaving(false);
    if (res.ok) {
      done();
      return;
    }
    setError(res.error);
    setSlots({ key: "", list: [] }); // время могли занять — перечитаем
  };

  const save = async () => {
    if (saving || !dirty) return;
    if (!name) {
      setError("Укажите имя клиента.");
      return;
    }
    if (!ready) return;
    setSaving(true);
    setError("");

    if (clientOnly) {
      if (st.c === NEW) {
        const res = await createClient(st.cf);
        finish(res, () => onDone({ toast: `${name} добавлена в базу.`, clientId: res.id }));
      } else {
        const res = await updateClient(st.c, st.cf);
        finish(res, () => onDone({ toast: "Данные клиента сохранены." }));
      }
      return;
    }

    if (!isEdit) {
      const res = await createMasterBooking({
        clientId: st.c === NEW ? null : st.c,
        newClient:
          st.c === NEW
            ? {
                name: st.newName,
                phone: st.newPhone,
                telegram_username: st.newTg,
                channel: st.newCh,
              }
            : undefined,
        serviceId: st.s,
        day: st.d,
        startMin: st.t,
        comment: st.cm,
      });
      finish(res, () =>
        onDone({
          toast: `${name} записана: ${lower(labelForKey(st.d))}, ${toHHMM(st.t)}.`,
          day: st.d,
          view: "day",
        })
      );
      return;
    }

    const res = await updateMasterBooking(editId, {
      clientId: st.c === NEW ? null : st.c,
      client: st.c === NEW ? { ...st.cf, channel: st.newCh } : st.cf,
      serviceId: st.s,
      day: st.d,
      startMin: st.t,
      comment: st.cm,
    });
    const moved = `Запись перенесена на ${lower(labelForKey(st.d))}, ${toHHMM(st.t)}`;
    const toast = notifies
      ? `${slotChanged ? moved : wasNew ? "Запись подтверждена" : "Запись обновлена"} — открываем чат с клиентом.`
      : slotChanged
        ? `${moved}. Отправьте клиенту сообщение.`
        : wasNew && !changed
          ? "Запись подтверждена."
          : cfChanged
            ? "Данные клиента и запись сохранены."
            : "Запись обновлена.";
    // Уже сохранено — теперь можно открыть чат (он обычно закрывает кабинет).
    finish(res, () => {
      if (notifies && message) openChatWith(clientTg, message);
      onDone({ toast, day: st.d });
    });
  };

  // Запись из мини-аппа отменяется статусом — клиент увидит «Отменена
  // мастером» сам, а с логином ему ещё и откроется чат с сообщением;
  // остальные удаляются (см. cancelBooking в api.js).
  const cancelThis = async () => {
    if (saving) return;
    setSaving(true);
    const res = await cancelBooking(bk);
    finish(res, () => {
      const told =
        canMessageClient(bk) &&
        !isBookingPast(bk) &&
        notifyClient(bk, dropKind(bk), settings?.masterName);
      onDone({
        toast: told
          ? "Запись отменена — открываем чат с клиентом."
          : clientSeesStatus(bk)
            ? "Запись отменена — клиент увидит это в «Мои записи»."
            : "Запись отменена. Сообщите клиенту.",
      });
    });
  };

  /* ─── Тексты шапки ──────────────────────────────────────────── */

  const idx = STEP_INDEX[st.step];
  const stepLabel = clientOnly
    ? "Клиент"
    : isEdit
      ? st.step === "confirm"
        ? "Изменить запись"
        : "Перенос записи"
      : `Шаг ${idx + 1} из 4`;
  const title = {
    client: isEdit ? "Другой клиент" : "Кого записываем?",
    service: "Выберите услугу",
    day: isEdit ? "Перенос: день" : "Выберите день",
    time: isEdit ? "Перенос: время" : "Выберите время",
    confirm: clientOnly ? name || "Новый клиент" : isEdit ? name || "Клиент" : "Проверьте запись",
  }[st.step];
  const sub = {
    client: "",
    service: name ? `Клиент: ${name}` : "",
    day: sv ? [name, sv.name].filter(Boolean).join(" · ") : "",
    time: st.d && sv ? `${labelForKey(st.d)} · ${sv.name}` : "",
    confirm:
      isEdit && sv && st.t != null
        ? `${sv.name} · ${toHHMM(st.t)}–${toHHMM(st.t + sv.duration)}`
        : "",
  }[st.step];

  const message =
    st.step === "confirm" && !clientOnly && sv && st.d && st.t != null
      ? clientMessage({
          kind: !isEdit
            ? "new"
            : slotChanged
              ? "moved"
              : wasNew
                ? "approved"
                : changed
                  ? "updated"
                  : "reminder",
          clientName: name,
          masterName: settings?.masterName,
          was: isEdit ? { day: st.orig.d, startMin: st.orig.t } : null,
          serviceName: sv.name,
          day: st.d,
          startMin: st.t,
          price: sv.price,
        })
      : "";

  // «Отправьте в WhatsApp» — но не «в Звонок»: для звонка и встречи
  // лично мастеру просто нужен текст под рукой.
  const where =
    channel && channel !== "call" && channel !== "live" ? channelLabel(channel) : "чат с клиентом";

  const copy = async () => {
    if (await copyText(message)) patch({ copied: true });
    else setError("Не удалось скопировать — выделите текст вручную.");
  };

  const saveLabel = clientOnly
    ? st.c === NEW
      ? "Добавить клиента"
      : cfChanged
        ? "Сохранить"
        : "Изменений нет"
    : !isEdit
      ? "Записать клиента"
      : wasNew
        ? changed
          ? "Сохранить и подтвердить"
          : "Подтвердить запись"
        : changed
          ? "Сохранить изменения"
          : "Изменений нет";

  /* ─── Шаг «Клиент» ──────────────────────────────────────────── */

  const renderClientStep = () => {
    const q = st.q.trim().toLowerCase();
    const found = clients
      .filter((c) => c.name)
      .filter(
        (c) =>
          !q ||
          [c.name, c.telegram_username, c.phone].some((v) => (v || "").toLowerCase().includes(q))
      );
    const ph = digits(st.newPhone);
    const dupe =
      ph.length >= 6
        ? clients.find((c) => c.name && digits(c.phone).endsWith(ph.slice(-9)))
        : null;

    return (
      <div className="bk-step">
        {st.newOpen ? (
          <div className="bk-new-form">
            <p className="client-label">Регистрация клиента</p>
            <input
              className="field compact sunk"
              placeholder="Имя *"
              aria-label="Имя"
              autoComplete="off"
              value={st.newName}
              onChange={(e) => patch({ newName: e.target.value })}
            />
            <input
              className="field compact sunk"
              type="tel"
              placeholder="Телефон"
              aria-label="Телефон"
              autoComplete="off"
              value={st.newPhone}
              onChange={(e) => patch({ newPhone: e.target.value })}
            />
            <input
              className="field compact sunk"
              placeholder="Telegram (если есть), без @"
              aria-label="Telegram"
              autoComplete="off"
              value={st.newTg}
              onChange={(e) => patch({ newTg: e.target.value })}
            />
            {dupe && (
              <div className="bk-dupe">
                <span>Этот номер уже есть: {dupe.name}</span>
                <button className="link-btn" type="button" onClick={() => pickClient(dupe)}>
                  Выбрать
                </button>
              </div>
            )}
            <p className="client-label bk-channel-label">Откуда пишет</p>
            <div className="bk-chips">
              {CHANNELS.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  className="bk-chip"
                  aria-pressed={st.newCh === ch.id ? "true" : "false"}
                  onClick={() => patch({ newCh: ch.id })}
                >
                  {ch.label}
                </button>
              ))}
            </div>
            <div className="bk-form-actions">
              <button
                className="bk-btn-main"
                type="button"
                data-ready={st.newName.trim() ? "true" : "false"}
                onClick={submitNew}
              >
                {isEdit ? "Готово" : "Дальше — услуга"}
              </button>
              <button className="bk-btn-quiet" type="button" onClick={() => patch({ newOpen: false })}>
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <button className="bk-new-card" type="button" onClick={() => patch({ newOpen: true })}>
            <span className="bk-new-plus">
              <Icon name="plus" size={14} />
            </span>
            <span className="bk-new-text">
              <span className="bk-new-title">Новый клиент</span>
              <span className="bk-new-sub">Написала в WhatsApp, Instagram, позвонила</span>
            </span>
          </button>
        )}

        <p className="eyebrow bk-eyebrow">Или выберите из базы</p>
        <input
          type="search"
          className="field compact sunk"
          placeholder="Имя, телеграм или телефон"
          aria-label="Поиск клиента"
          value={st.q}
          onChange={(e) => patch({ q: e.target.value })}
        />
        <div className="bk-list">
          {found.length === 0 ? (
            <p className="bk-list-empty">Никого не нашлось — зарегистрируйте нового клиента</p>
          ) : (
            found.map((c) => {
              const meta =
                [
                  c.telegram_username && `@${c.telegram_username}`,
                  c.phone,
                  c.channel && c.channel !== "tg" && channelLabel(c.channel),
                ]
                  .filter(Boolean)
                  .join(" · ") || "без контактов";
              return (
                <button className="bk-list-row" type="button" key={c.id} onClick={() => pickClient(c)}>
                  <span className="client-monogram sm">{c.name.charAt(0).toUpperCase()}</span>
                  <span className="bk-list-main">
                    <span className="bk-list-name">{c.name}</span>
                    <span className="bk-list-meta">{meta}</span>
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  };

  /* ─── Шаги «Услуга», «День», «Время» ────────────────────────── */

  const renderServiceStep = () => (
    <div className="bk-step bk-services">
      {active.map((s) => (
        <button
          key={s.id}
          type="button"
          className="bk-service"
          aria-pressed={st.s === s.id ? "true" : "false"}
          disabled={checking}
          onClick={() => pickService(s.id)}
        >
          <span className="bk-service-main">
            <span className="bk-service-name">{s.name}</span>
            <span className="bk-service-meta">{s.duration} мин</span>
          </span>
          <span className="bk-service-price">{formatPrice(s.price)}</span>
        </button>
      ))}
    </div>
  );

  const renderDayStep = () => {
    const days = [];
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      const k = dateKey(date);
      const closed = isDayClosed(settings, daysOff, k);
      const n = counts.map.get(k) ?? 0;
      const state = closed
        ? "выходной"
        : countsLoading
          ? "…"
          : n
            ? `свободно окошек: ${n}`
            : "всё занято";
      days.push({
        k,
        weekday: WD_SHORT[date.getDay()],
        num: date.getDate(),
        label:
          i === 0
            ? `Сегодня, ${fDayMonth.format(date)}`
            : i === 1
              ? `Завтра, ${fDayMonth.format(date)}`
              : labelForKey(k),
        meta: (isEdit && k === st.orig.d ? "текущий день · " : "") + state,
        disabled: closed || countsLoading || !n,
      });
    }
    return (
      <div className="bk-step">
        <div className="bk-days">
          {days.map((d) => (
            <button
              key={d.k}
              type="button"
              className="bk-day"
              disabled={d.disabled}
              onClick={() => go("time", { d: d.k, t: null })}
            >
              <span className="bk-day-date">
                <span className="bk-day-wd">{d.weekday}</span>
                <span className="bk-day-num">{d.num}</span>
              </span>
              <span className="bk-day-main">
                <span className="bk-day-label">{d.label}</span>
                <span className="bk-day-meta">{d.meta}</span>
              </span>
              <Icon name="chevronRight" size={15} />
            </button>
          ))}
        </div>
        <label className="bk-other-date">
          <span>Другая дата</span>
          <input
            type="date"
            className="field compact sunk"
            min={today}
            value=""
            onChange={(e) => e.target.value && go("time", { d: e.target.value, t: null })}
          />
        </label>
      </div>
    );
  };

  const renderTimeStep = () => {
    if (slotsLoading) return <p className="sheet-hint">Ищем свободное время…</p>;
    if (slots.list.length === 0) {
      return (
        <div className="bk-noslots">
          <p>На этот день нет места под эту услугу</p>
          <button className="link-btn" type="button" onClick={back}>
            Выбрать другой день
          </button>
        </div>
      );
    }
    return (
      <div className="bk-step bk-slots">
        {slots.list.map((m) => (
          <button
            key={m}
            type="button"
            className="bk-slot"
            aria-pressed={st.t === m ? "true" : "false"}
            onClick={() => go("confirm", { t: m })}
          >
            {toHHMM(m)}
          </button>
        ))}
      </div>
    );
  };

  /* ─── Шаг «Проверка» ────────────────────────────────────────── */

  const summary = () => {
    if (!sv || st.t == null || !st.d) return [];
    const when = (d, t, dur) => `${labelForKey(d)}, ${toHHMM(t)}–${toHHMM(t + dur)}`;
    if (isEdit) {
      return [
        {
          k: "Услуга",
          v: sv.name,
          old: origView.name,
          changed: st.s !== st.orig.s,
          act: "Изменить",
          to: () => go("service"),
        },
        {
          k: "Когда",
          v: when(st.d, st.t, sv.duration),
          old: when(st.orig.d, st.orig.t, origView.duration),
          changed: slotChanged,
          act: "Перенести",
          to: () => go("day"),
        },
        {
          k: "Стоимость",
          v: formatPrice(sv.price),
          old: formatPrice(origView.price),
          changed: sv.price !== origView.price,
        },
      ];
    }
    return [
      { k: "Клиент", v: name + (st.c === NEW ? " (новый)" : ""), to: () => go("client") },
      { k: "Услуга", v: sv.name, to: () => go("service") },
      { k: "Дата", v: labelForKey(st.d), to: () => go("day") },
      { k: "Время", v: `${toHHMM(st.t)}–${toHHMM(st.t + sv.duration)}`, to: () => go("time") },
      { k: "Стоимость", v: formatPrice(sv.price), to: () => go("service") },
    ].map((r) => ({ ...r, act: "изм." }));
  };

  const cfField = (key, label, type, placeholder) => (
    <label className="bk-cf-label">
      {label}
      <input
        type={type}
        className="field compact"
        placeholder={placeholder}
        autoComplete="off"
        value={st.cf[key]}
        onChange={(e) => {
          const v = e.target.value;
          setSt((p) => ({ ...p, cf: { ...p.cf, [key]: v } }));
        }}
      />
    </label>
  );

  const renderConfirm = () => (
    <div className="bk-step">
      {isEdit && (
        <div className="bk-badges">
          <span className="bk-status" data-status={bk.status}>
            <span className="bk-status-dot" />
            {wasNew ? "Ждёт подтверждения" : "Подтверждена"}
          </span>
          {changed && <span className="bk-changed">Есть изменения</span>}
        </div>
      )}

      {(isEdit || clientOnly) && (
        <>
          <div className="section-head">
            <p className="eyebrow">Клиент</p>
            {isEdit && (
              <button className="link-btn" type="button" onClick={() => go("client")}>
                Другой клиент
              </button>
            )}
          </div>
          <div className="bk-box">
            {cfField("name", "Имя", "text", "Имя клиента")}
            {cfField("phone", "Телефон", "tel", "+995 …")}
            {cfField("telegram_username", "Telegram", "text", "username без @")}
          </div>
          {isEdit && <p className="eyebrow bk-eyebrow">Запись</p>}
        </>
      )}

      {!clientOnly && (
        <>
          {isEdit && st.s === "" && (
            <p className="sheet-hint">Этой услуги больше нет в списке — выберите другую.</p>
          )}
          <div className="bk-summary">
            {summary().map((r) => (
              <div className="bk-sum-row" key={r.k}>
                <span className="bk-sum-k">{r.k}</span>
                <span className="bk-sum-right">
                  <span className="bk-sum-vals">
                    <span className="bk-sum-v" data-changed={r.changed ? "true" : "false"}>
                      {r.v}
                    </span>
                    {r.changed && <span className="bk-sum-old">{r.old}</span>}
                  </span>
                  {r.act && (
                    <button className="link-btn bk-sum-act" type="button" onClick={r.to}>
                      {r.act}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>

          <p className="eyebrow bk-eyebrow">Комментарий к записи</p>
          <textarea
            className="field compact sunk bk-comment"
            rows={2}
            placeholder="Например: снятие чужого покрытия"
            aria-label="Комментарий к записи"
            value={st.cm}
            onChange={(e) => patch({ cm: e.target.value })}
          />

          {message && (
            <>
              <div className="section-head">
                <p className="eyebrow">
                  {!isEdit
                    ? "Сообщение клиенту"
                    : slotChanged
                      ? "Сообщение о переносе"
                      : wasNew
                        ? "Сообщение о подтверждении"
                        : changed
                          ? "Сообщение об изменении"
                          : "Напоминание клиенту"}
                </p>
                <button className="link-btn" type="button" onClick={copy}>
                  {st.copied ? "Скопировано" : "Скопировать"}
                </button>
              </div>
              <pre className="bk-msg">{message}</pre>
              <p className="bk-note">
                {notifies
                  ? `После сохранения откроется чат с @${clientTg.trim().replace(/^@/, "")} с этим текстом.`
                  : isEdit
                    ? `Отправьте в ${where} после сохранения.`
                    : `Отправьте в ${where}. Запись создаётся сразу подтверждённой.`}
              </p>
            </>
          )}
        </>
      )}

      {error && <p className="form-error sheet-error">⚠️ {error}</p>}

      <button
        className="bk-save"
        type="button"
        data-ready={ready ? "true" : "false"}
        disabled={saving}
        onClick={save}
      >
        {saving && <span className="btn-spinner" aria-hidden="true" />}
        {saveLabel}
      </button>

      {isEdit &&
        (st.askCancel ? (
          <div className="bk-cancel-box">
            <p>
              Отменить запись: {name || "клиент"}, {lower(labelForKey(st.orig.d))} в{" "}
              {toHHMM(st.orig.t)}?
            </p>
            <div className="bk-cancel-actions">
              <button className="bk-btn-danger" type="button" disabled={saving} onClick={cancelThis}>
                Да, отменить
              </button>
              <button className="bk-btn-quiet" type="button" onClick={() => patch({ askCancel: false })}>
                Оставить
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn-text danger bk-cancel-link"
            type="button"
            onClick={() => patch({ askCancel: true })}
          >
            Отменить запись
          </button>
        ))}
    </div>
  );

  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="bk-title">
        <div className="sheet-nav">
          <button className="round-btn sheet-nav-btn" type="button" aria-label="Назад" onClick={back}>
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="sheet-step">{stepLabel}</span>
          <button
            className="round-btn sheet-nav-btn is-muted"
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {!isEdit && !clientOnly ? (
          <div className="sheet-bars" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="sheet-bar" data-on={i <= idx ? "true" : "false"} />
            ))}
          </div>
        ) : (
          <div className="sheet-bars-gap" />
        )}

        <h2 className="sheet-title" id="bk-title">
          {title}
        </h2>
        {sub && <p className="sheet-sub">{sub}</p>}

        {st.step === "client" && renderClientStep()}
        {st.step === "service" && renderServiceStep()}
        {st.step === "day" && renderDayStep()}
        {st.step === "time" && renderTimeStep()}
        {st.step === "confirm" && renderConfirm()}

        {st.step !== "confirm" && error && <p className="form-error">⚠️ {error}</p>}
      </div>
    </div>
  );
}
