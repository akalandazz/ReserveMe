import { useState } from "react";
import { SLOT_STEPS, normalizeSettingsFields, saveSettings, validateSettingsFields } from "../api.js";

// Сколько минут до начала клиент ещё может записаться на сегодня
// (settings.min_lead_minutes). Значение не из списка (выставлено в SQL)
// добавляется в список как есть — см. leadOptions.
const LEAD_STEPS = [0, 30, 60, 120, 180, 360, 720, 1440, 2880];

function leadLabel(m) {
  if (m === 0) return "Без ограничения";
  if (m % 1440 === 0) return `За ${m / 1440} ${m === 1440 ? "сутки" : "суток"}`;
  if (m % 60 === 0) return `За ${m / 60} ч`;
  return `За ${m} мин`;
}

function leadOptions(current) {
  const list = LEAD_STEPS.includes(current)
    ? LEAD_STEPS
    : [...LEAD_STEPS, current].sort((a, b) => a - b);
  return list.map((m) => ({ value: m, label: leadLabel(m) }));
}

const GROUPS = [
  {
    id: "profile",
    title: "Профиль мастера",
    note: "Имя и телефон видят клиенты; на логин уходят их заявки.",
    toast: "Профиль сохранён — клиенты видят новые данные.",
    fields: [
      { key: "masterName", label: "Имя", placeholder: "Как к вам обращаться" },
      {
        key: "masterUsername",
        label: "Логин Telegram",
        placeholder: "без @",
        hint: (v) =>
          v.trim().replace(/^@+/, "") ? null : "Без логина клиенты не смогут отправить вам заявку.",
      },
      { key: "masterPhone", label: "Телефон", type: "tel", placeholder: "+7 …" },
    ],
  },
  {
    id: "location",
    title: "Адрес и как добраться",
    note: "Раздел «Как нас найти» у клиента и текст напоминания.",
    toast: "Адрес сохранён — клиенты видят новые данные.",
    fields: [
      { key: "address", label: "Адрес", placeholder: "Улица, дом, квартира" },
      { key: "landmark", label: "Как войти", multiline: true, placeholder: "Домофон, этаж" },
      { key: "transport", label: "Как добраться", multiline: true },
      { key: "mapUrl", label: "Ссылка на карту", type: "url", placeholder: "https://…" },
      {
        key: "workingHoursText",
        label: "Время работы (текст)",
        placeholder: "Пн–Сб, 10:00–19:00",
        hint: () => "Это подпись для клиентов; окошки считаются по графику ниже.",
      },
    ],
  },
  {
    id: "rules",
    title: "Правила записи",
    note: "Окошки для записи пересчитываются сразу. Уже созданные записи остаются.",
    toast: "Правила записи сохранены.",
    fields: [
      {
        key: "slotStepMinutes",
        label: "Шаг окошек",
        options: () => SLOT_STEPS.map((m) => ({ value: m, label: `${m} мин` })),
        hint: (v, saved) =>
          Number(v) !== saved
            ? "Закрытые окошки, которые не попадут на новую сетку, перестанут действовать."
            : null,
      },
      { key: "bookingDaysAhead", label: "Запись вперёд, дней", type: "number", min: 1, max: 60 },
      {
        key: "minLeadMinutes",
        label: "Запись на сегодня — не позже чем",
        options: (saved) => leadOptions(saved),
      },
    ],
  },
];

/**
 * Профиль, адрес и правила записи — та же строка settings, что и
 * график с напоминаниями (ScheduleSection), но текстовые поля
 * сохраняются черновиком с «Сохранить», как услуги: сохранять на
 * каждую букву нельзя. У каждой группы свой черновик — saveSettings
 * пишет только её поля.
 */
export default function SalonSection({ settings, busy, busyThen, onToast, onError }) {
  return GROUPS.map((group) => (
    <SettingsGroup
      key={group.id}
      group={group}
      settings={settings}
      busy={busy}
      busyThen={busyThen}
      onToast={onToast}
      onError={onError}
    />
  ));
}

function SettingsGroup({ group, settings, busy, busyThen, onToast, onError }) {
  const [draft, setDraft] = useState(null);
  const [fieldError, setFieldError] = useState("");

  const saved = (key) => settings[key];
  const value = (key) => (draft ? draft[key] : saved(key));
  const dirty = draft !== null;
  const busyKey = `settings-${group.id}`;

  const edit = (key, v) => {
    setDraft((d) => ({
      ...(d ?? Object.fromEntries(group.fields.map((f) => [f.key, saved(f.key)]))),
      [key]: v,
    }));
  };
  const reset = () => {
    setDraft(null);
    setFieldError("");
  };

  const save = () => {
    if (busy || !draft) return;
    const fields = normalizeSettingsFields(draft);
    const err = validateSettingsFields(fields);
    if (err) {
      setFieldError(err);
      return;
    }
    setFieldError("");
    // Только то, что правда поменялось: лишняя колонка в PATCH ничего не
    // ломает, но так в запросе видно, что именно правила мастер.
    const changed = Object.fromEntries(
      Object.entries(fields).filter(([key, v]) => v !== saved(key))
    );
    busyThen(busyKey, 400, async () => {
      const res = await saveSettings(changed);
      if (!res.ok) {
        onError(res.error);
        return;
      }
      setDraft(null);
      onToast(group.toast);
    });
  };

  return (
    <div>
      <p className="eyebrow">{group.title}</p>
      <div className="schedule-panel" data-testid={`settings-${group.id}`}>
        <div className="salon-fields">
          {group.fields.map((f) => {
            const v = value(f.key);
            const id = `settings-${f.key}`;
            const hint = f.hint?.(String(v ?? ""), saved(f.key));
            return (
              <div className="salon-field" key={f.key}>
                <label className="salon-label" htmlFor={id}>
                  {f.label}
                </label>
                {f.options ? (
                  <select
                    id={id}
                    className="field compact"
                    value={v}
                    onChange={(e) => edit(f.key, Number(e.target.value))}
                  >
                    {f.options(saved(f.key)).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.multiline ? (
                  <textarea
                    id={id}
                    className="field compact"
                    rows={2}
                    placeholder={f.placeholder}
                    value={v}
                    onChange={(e) => edit(f.key, e.target.value)}
                  />
                ) : (
                  <input
                    id={id}
                    type={f.type ?? "text"}
                    inputMode={f.type === "number" ? "numeric" : undefined}
                    min={f.min}
                    max={f.max}
                    className="field compact"
                    placeholder={f.placeholder}
                    autoComplete="off"
                    value={v}
                    onChange={(e) => edit(f.key, e.target.value)}
                  />
                )}
                {hint && <span className="salon-hint">{hint}</span>}
              </div>
            );
          })}
          {fieldError && <p className="form-error">{fieldError}</p>}
        </div>

        <div className="services-foot">
          <span className="services-note">
            {dirty ? "Есть несохранённые изменения." : group.note}
          </span>
          {dirty && (
            <button className="btn-cancel-draft" type="button" onClick={reset}>
              Отменить
            </button>
          )}
          <button className="btn-save" type="button" disabled={!dirty || !!busy} onClick={save}>
            {busy === busyKey && <span className="btn-spinner" aria-hidden="true" />}
            {busy === busyKey ? "Сохраняем" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
