import { useState } from "react";
import { toHHMM, toMinutes } from "../../schedule.js";
import { saveWorkingHours } from "../api.js";

const LABELS = ["Воскр.", "Понед.", "Вторн.", "Среда", "Четв.", "Пятн.", "Суббота"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * Правки применяются сразу — как «Закрыть день» в панели дня, а не
 * копятся в черновике с отдельным «Сохранить», как у услуг: щелчок
 * ± — это одно небольшое изменение settings.working_hours целиком.
 *
 * Затравка локального состояния из settings — не эффектом, а прямо
 * в теле рендера (официальный паттерн React «adjusting state when a
 * prop changes»): settings приходит из стора асинхронно и один раз,
 * эффект тут означал бы лишний повторный рендер сразу после первого.
 */
export default function ScheduleSection({ settings, onError }) {
  const [hours, setHours] = useState({});
  const [seeded, setSeeded] = useState(false);

  if (settings && !seeded) {
    setHours(settings.workingHours ?? {});
    setSeeded(true);
  }

  const persist = async (next) => {
    const res = await saveWorkingHours(next);
    if (!res.ok) onError(res.error);
  };

  const toggle = (dow) => {
    const cur = hours[dow];
    const next = { ...hours, [dow]: cur ? null : { from: "10:00", to: "19:00" } };
    setHours(next);
    persist(next);
  };

  const shift = (dow, field, delta) => {
    const cur = hours[dow];
    if (!cur) return;
    const patched = { ...cur };
    const m = Math.max(360, Math.min(1380, toMinutes(patched[field]) + delta * 30));
    patched[field] = toHHMM(m);
    if (toMinutes(patched.to) - toMinutes(patched.from) < 60) return;
    const next = { ...hours, [dow]: patched };
    setHours(next);
    persist(next);
  };

  return (
    <div>
      <p className="eyebrow">График работы</p>
      <div className="schedule-panel">
        {DOW_ORDER.map((dow) => {
          const h = hours[dow];
          return (
            <div className={h ? "hours-row" : "hours-row is-closed"} key={dow}>
              <span className="hours-day-label">{LABELS[dow]}</span>
              <span className="hours-controls">
                {h ? (
                  <span className="hours-open">
                    <button
                      className="stepper-btn"
                      type="button"
                      aria-label="Раньше"
                      onClick={() => shift(dow, "from", -1)}
                    >
                      −
                    </button>
                    <span className="hours-value">{h.from}</span>
                    <button
                      className="stepper-btn"
                      type="button"
                      aria-label="Позже"
                      onClick={() => shift(dow, "from", 1)}
                    >
                      +
                    </button>
                    <span className="hours-sep">–</span>
                    <button
                      className="stepper-btn"
                      type="button"
                      aria-label="Раньше"
                      onClick={() => shift(dow, "to", -1)}
                    >
                      −
                    </button>
                    <span className="hours-value">{h.to}</span>
                    <button
                      className="stepper-btn"
                      type="button"
                      aria-label="Позже"
                      onClick={() => shift(dow, "to", 1)}
                    >
                      +
                    </button>
                  </span>
                ) : (
                  <span className="hours-closed-label">Выходной</span>
                )}
              </span>
              <button
                className="hours-switch"
                type="button"
                role="switch"
                aria-checked={Boolean(h)}
                aria-label="Рабочий день"
                onClick={() => toggle(dow)}
              >
                <span className="hours-knob" />
              </button>
            </div>
          );
        })}
        <p className="schedule-note">
          Окошки для записи пересчитываются автоматически. Уже созданные записи остаются.
        </p>
      </div>
    </div>
  );
}
