import { useState } from "react";
import {
  addDayOff,
  removeDayOff,
  saveSettings,
  validateSettings,
} from "../../content.js";
import { dateKey, labelForKey } from "../../schedule.js";
import { haptic } from "../../telegram.js";
import { PrimaryButton, Screen, Title } from "../../ui.jsx";

// 0 — воскресенье, как в Date.getDay(). Показываем с понедельника.
const DOW_LABELS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

const STEPS = [5, 10, 15, 20, 30, 60];

export default function AdminSchedule({ settings, daysOff, onBack }) {
  const [f, setF] = useState(() => ({
    workingHours: { ...settings.workingHours },
    slotStepMinutes: String(settings.slotStepMinutes),
    bookingDaysAhead: String(settings.bookingDaysAhead),
    minLeadMinutes: String(settings.minLeadMinutes),
    workingHoursText: settings.workingHoursText,
    timeOfDay: settings.timeOfDay.map((p) => ({ ...p })),
  }));
  const [newDay, setNewDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const setHours = (dow, patch) =>
    setF((prev) => ({
      ...prev,
      workingHours: {
        ...prev.workingHours,
        [dow]: patch === null ? null : { ...(prev.workingHours[dow] ?? {}), ...patch },
      },
    }));

  const toggleDay = (dow) =>
    setHours(dow, f.workingHours[dow] ? null : { from: "10:00", to: "19:00" });

  const setPart = (i, label) =>
    setF((prev) => ({
      ...prev,
      timeOfDay: prev.timeOfDay.map((p, n) => (n === i ? { ...p, label } : p)),
    }));

  const save = async () => {
    if (busy) return;
    const next = {
      ...settings,
      workingHours: f.workingHours,
      slotStepMinutes: Number(f.slotStepMinutes),
      bookingDaysAhead: Number(f.bookingDaysAhead),
      minLeadMinutes: Number(f.minLeadMinutes),
      workingHoursText: f.workingHoursText.trim(),
      timeOfDay: f.timeOfDay,
    };

    const problem = validateSettings(next);
    if (problem) {
      setError(problem);
      return;
    }
    if (!STEPS.includes(next.slotStepMinutes)) {
      setError("Шаг сетки: 5, 10, 15, 20, 30 или 60 минут");
      return;
    }
    if (next.bookingDaysAhead < 1 || next.bookingDaysAhead > 60) {
      setError("Горизонт записи — от 1 до 60 дней");
      return;
    }
    if (next.minLeadMinutes < 0 || next.minLeadMinutes > 10080) {
      setError("Запас перед записью — от 0 до 10080 минут");
      return;
    }

    setBusy(true);
    setError("");
    const res = await saveSettings(next);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else haptic("success");
  };

  const addOff = async () => {
    if (!newDay || busy) return;
    setBusy(true);
    setError("");
    const res = await addDayOff(newDay);
    setBusy(false);
    if (res.ok) setNewDay("");
    else setError(res.error);
  };

  const removeOff = async (day) => {
    setBusy(true);
    setError("");
    const res = await removeDayOff(day);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  const today = dateKey(new Date());

  return (
    <Screen
      crumb="График"
      onBack={onBack}
      footer={
        <PrimaryButton onClick={save} disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить график"}
        </PrimaryButton>
      }
    >
      <Title>График работы</Title>

      <p className="eyebrow">Часы по дням недели</p>
      <div className="divided flush">
        {DOW_ORDER.map((dow) => {
          const hours = f.workingHours[dow];
          return (
            <div key={dow} className="hours-row">
              <button
                className="dow-label"
                type="button"
                onClick={() => toggleDay(dow)}
                aria-label={`Переключить ${DOW_LABELS[dow]}`}
              >
                {DOW_LABELS[dow]}
              </button>
              {hours ? (
                <>
                  <input
                    className="field"
                    type="time"
                    value={hours.from}
                    aria-label={`Начало, ${DOW_LABELS[dow]}`}
                    onChange={(e) => setHours(dow, { from: e.target.value })}
                  />
                  <input
                    className="field"
                    type="time"
                    value={hours.to}
                    aria-label={`Окончание, ${DOW_LABELS[dow]}`}
                    onChange={(e) => setHours(dow, { to: e.target.value })}
                  />
                </>
              ) : (
                <span className="day-off">выходной — нажмите день, чтобы открыть</span>
              )}
            </div>
          );
        })}
      </div>
      <p className="admin-hint">
        Окончание — это время, к которому услуга должна закончиться.
        Нажатие на день недели делает его выходным и обратно.
      </p>

      <div className="form-grid">
        <div>
          <label className="eyebrow" htmlFor="sch-step">
            Шаг сетки, мин
          </label>
          <input
            id="sch-step"
            className="field"
            type="number"
            inputMode="numeric"
            value={f.slotStepMinutes}
            onChange={(e) =>
              setF((p) => ({ ...p, slotStepMinutes: e.target.value }))
            }
          />
        </div>
        <div>
          <label className="eyebrow" htmlFor="sch-ahead">
            Запись на, дней
          </label>
          <input
            id="sch-ahead"
            className="field"
            type="number"
            inputMode="numeric"
            value={f.bookingDaysAhead}
            onChange={(e) =>
              setF((p) => ({ ...p, bookingDaysAhead: e.target.value }))
            }
          />
        </div>
      </div>

      <label className="eyebrow" htmlFor="sch-lead">
        Минимальный запас на сегодня, мин
      </label>
      <input
        id="sch-lead"
        className="field"
        type="number"
        inputMode="numeric"
        value={f.minLeadMinutes}
        onChange={(e) =>
          setF((p) => ({ ...p, minLeadMinutes: e.target.value }))
        }
      />
      <p className="admin-hint">
        За сколько минут до визита ещё можно записаться на сегодня.
      </p>

      <label className="eyebrow" htmlFor="sch-text">
        Время работы текстом
      </label>
      <textarea
        id="sch-text"
        className="field"
        rows={2}
        value={f.workingHoursText}
        onChange={(e) =>
          setF((p) => ({ ...p, workingHoursText: e.target.value }))
        }
      />
      <p className="admin-hint">
        Показывается на главной и на экране «Как меня найти».
      </p>

      <p className="eyebrow">Время суток для листа ожидания</p>
      {f.timeOfDay.map((p, i) => (
        <input
          key={p.id}
          className="field"
          type="text"
          maxLength={40}
          value={p.label}
          aria-label={`Вариант ${i + 1}`}
          onChange={(e) => setPart(i, e.target.value)}
        />
      ))}

      <p className="eyebrow">Выходные и отпуск</p>
      <div className="chips">
        {daysOff.map((day) => (
          <button
            key={day}
            className="chip"
            type="button"
            disabled={busy}
            onClick={() => removeOff(day)}
            aria-label={`Убрать выходной ${day}`}
          >
            {labelForKey(day)} ✕
          </button>
        ))}
      </div>
      {daysOff.length === 0 && (
        <p className="admin-hint">Отдельных выходных пока нет.</p>
      )}

      <div className="form-grid">
        <input
          className="field"
          type="date"
          value={newDay}
          min={today}
          aria-label="Новый выходной"
          onChange={(e) => setNewDay(e.target.value)}
        />
        <PrimaryButton inline onClick={addOff} disabled={!newDay || busy}>
          Добавить выходной
        </PrimaryButton>
      </div>
      <p className="admin-hint">
        Выходные сохраняются сразу, отдельно от кнопки внизу.
      </p>

      {error && <p className="form-error">{error}</p>}
    </Screen>
  );
}
