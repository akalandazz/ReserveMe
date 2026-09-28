import { useEffect, useState } from "react";
import { dateKey, toHHMM } from "../../schedule.js";
import { createMasterBooking, fetchFreeSlots } from "../api.js";
import { Icon } from "./Icons.jsx";

const NEW_CLIENT = "new";

function serviceLabel(s) {
  return `${s.name} · ${s.duration} мин · ${s.price} ₾`;
}

function clientLabel(c) {
  const name = c.name || "Без имени";
  return c.telegram_username ? `${name} · @${c.telegram_username}` : name;
}

/**
 * Лист «Новая запись»: мастер записывает клиента сама. Запись сразу
 * подтверждённая и в «Заявки» не попадает (см. create_master_booking
 * в schema.sql).
 *
 * Время — только из free_slots() на сервере: там же его перепроверяет
 * create_master_booking, так что список и запись не разойдутся.
 *
 * initial: { clientId?, day, time? } — откуда открыли: шапка
 * «Расписания» (выбранный день), свободная строка панели дня (день и
 * время), карточка клиента (клиент).
 */
export default function NewBookingSheet({ clients, services, initial, onClose, onBooked }) {
  const active = services.filter((s) => s.active !== false);

  const favoriteFor = (clientId) => {
    const c = clients.find((x) => String(x.id) === String(clientId));
    const fav = c?.favorite_service_id;
    return fav && active.some((s) => s.id === fav) ? fav : "";
  };

  const [clientSel, setClientSel] = useState(
    initial.clientId != null ? String(initial.clientId) : ""
  );
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [serviceId, setServiceId] = useState(() => favoriteFor(initial.clientId));
  const [day, setDay] = useState(initial.day);
  const [time, setTime] = useState(initial.time != null ? String(initial.time) : "");
  // { key: "день|услуга", list: [минуты] } — key отличает свежий ответ
  // от ответа на прошлый выбор: пока они не совпали, идёт загрузка.
  const [slots, setSlots] = useState({ key: "", list: [] });
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  // Своя строка ошибки, а не тост кабинета: тост стоит в потоке страницы
  // и оказался бы под затемнением листа.
  const [error, setError] = useState("");

  const slotsKey = day && serviceId ? `${day}|${serviceId}` : "";
  const loading = slotsKey !== "" && slots.key !== slotsKey;

  useEffect(() => {
    if (!slotsKey) return;
    let cancelled = false;
    const [d, s] = slotsKey.split("|");
    fetchFreeSlots(d, s).then((res) => {
      if (cancelled) return;
      if (!res.ok) setError(res.error);
      setSlots({ key: slotsKey, list: res.slots });
      // Время, пришедшее из свободной строки или выбранное раньше,
      // оставляем, только если оно всё ещё подходит под услугу и дату.
      setTime((t) => (t !== "" && res.slots.includes(Number(t)) ? t : ""));
    });
    return () => {
      cancelled = true;
    };
  }, [slotsKey, reload]);

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

  const pickClient = (value) => {
    setClientSel(value);
    if (value && value !== NEW_CLIENT) {
      const fav = favoriteFor(value);
      if (fav) setServiceId(fav);
    }
  };

  const isNew = clientSel === NEW_CLIENT;
  const hasClient = isNew ? newName.trim() !== "" : clientSel !== "";
  const list = loading ? [] : slots.list;
  const ready = hasClient && serviceId !== "" && time !== "" && !loading;

  let hint;
  if (!serviceId) hint = "Выберите услугу, чтобы увидеть свободное время.";
  else if (!day) hint = "Выберите дату.";
  else if (loading) hint = "Ищем свободное время…";
  else if (list.length === 0) hint = "На эту дату нет свободного времени под выбранную услугу.";
  else hint = "Запись сразу попадёт в расписание как подтверждённая.";

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError("");
    const startMin = Number(time);
    const existing = isNew ? null : clients.find((c) => String(c.id) === clientSel);
    const res = await createMasterBooking({
      clientId: existing ? existing.id : null,
      newName: isNew ? newName.trim() : "",
      newPhone: isNew ? newPhone.trim() : "",
      serviceId,
      day,
      startMin,
    });
    setSaving(false);
    if (res.ok) {
      onBooked({ day, startMin, name: existing ? existing.name || "Клиент" : newName.trim() });
    } else {
      setError(res.error);
      setReload((n) => n + 1); // время могли занять — перечитываем окна
    }
  };

  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="nb-title">
        <div className="sheet-head">
          <h2 className="sheet-title" id="nb-title">
            Новая запись
          </h2>
          <button className="icon-btn sheet-close" type="button" aria-label="Закрыть" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <label className="eyebrow" htmlFor="nb-client">
          Клиент
        </label>
        <select
          id="nb-client"
          className="field"
          value={clientSel}
          onChange={(e) => pickClient(e.target.value)}
        >
          <option value="">Выберите клиента</option>
          {clients.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {clientLabel(c)}
            </option>
          ))}
          <option value={NEW_CLIENT}>+ Новый клиент</option>
        </select>

        {isNew && (
          <div className="field-pair">
            <div>
              <label className="eyebrow" htmlFor="nb-name">
                Имя
              </label>
              <input
                id="nb-name"
                className="field"
                autoComplete="off"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div>
              <label className="eyebrow" htmlFor="nb-phone">
                Телефон
              </label>
              <input
                id="nb-phone"
                type="tel"
                className="field"
                autoComplete="off"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
              />
            </div>
          </div>
        )}

        <label className="eyebrow" htmlFor="nb-service">
          Услуга
        </label>
        <select
          id="nb-service"
          className="field"
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          <option value="">Выберите услугу</option>
          {active.map((s) => (
            <option key={s.id} value={s.id}>
              {serviceLabel(s)}
            </option>
          ))}
        </select>

        <div className="field-pair">
          <div>
            <label className="eyebrow" htmlFor="nb-day">
              Дата
            </label>
            <input
              id="nb-day"
              type="date"
              className="field"
              min={dateKey(new Date())}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div>
            <label className="eyebrow" htmlFor="nb-time">
              Время
            </label>
            <select
              id="nb-time"
              className="field"
              value={time}
              disabled={list.length === 0}
              onChange={(e) => setTime(e.target.value)}
            >
              <option value="">—</option>
              {list.map((m) => (
                <option key={m} value={String(m)}>
                  {toHHMM(m)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="sheet-hint">{hint}</p>
        {error && <p className="form-error sheet-error">⚠️ {error}</p>}

        <button
          className="btn-primary sheet-submit"
          type="button"
          disabled={!ready || saving}
          onClick={submit}
        >
          {saving && <span className="btn-spinner" aria-hidden="true" />}
          {saving ? "Записываем" : "Записать"}
        </button>
      </div>
    </div>
  );
}
