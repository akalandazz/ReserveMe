import { useRef, useState } from "react";
import { CURRENCY } from "../../money.js";
import {
  createService,
  deleteService,
  updateService,
  validateServiceFields,
} from "../api.js";
import { Icon } from "./Icons.jsx";

/**
 * Только name/duration/price — так в макете. emoji/note/active из
 * прежней админки сюда не входят: правки этих трёх полей не трогают
 * остальные колонки, а создание новой услуги берёт их значения по
 * умолчанию (см. supabase/schema.sql).
 *
 * Порядок массива — порядок услуг везде (services.sort = индекс + 1,
 * клиент читает order by sort). Стрелки и перетаскивание меняют только
 * черновик, как и правка полей: «Отменить» возвращает прежний порядок.
 */
export default function ServicesSection({ services, busy, busyThen, onToast, onError }) {
  const [draft, setDraft] = useState(null);
  const [fieldError, setFieldError] = useState("");
  // Перетаскиваемая услуга — в ref, чтобы dragstart не перерисовывал
  // список; в состоянии только подсвеченная строка.
  const dragId = useRef(null);
  const [overId, setOverId] = useState(null);

  const list = draft ?? services;
  const dirty = draft !== null;

  const edit = (id, field, value) => {
    setDraft((d) => (d ?? services).map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  };
  const remove = (id) => {
    setDraft((d) => (d ?? services).filter((s) => s.id !== id));
  };
  const add = () => {
    setDraft((d) => [
      ...(d ?? services),
      { id: `new${Date.now()}`, name: "", price: 0, duration: 60 },
    ]);
  };
  // Вынуть услугу с места from и вставить на индекс to (индекс в списке до
  // переноса) — так и вверх, и вниз она встаёт на место целевой строки.
  const move = (from, to) => {
    if (from === to || from < 0 || to < 0 || to >= list.length) return;
    setDraft((d) => {
      const next = [...(d ?? services)];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };
  const endDrag = () => {
    dragId.current = null;
    setOverId(null);
  };
  const reset = () => {
    setDraft(null);
    setFieldError("");
  };

  const commitSvc = async (cleaned) => {
    const originalIds = new Set(services.map((s) => s.id));
    const draftIds = new Set(cleaned.map((s) => s.id));
    const ops = [];
    for (const s of services) {
      if (!draftIds.has(s.id)) ops.push(deleteService(s.id));
    }
    cleaned.forEach((s, i) => {
      const fields = { name: s.name, price: s.price, duration: s.duration, sort: i + 1 };
      if (!originalIds.has(s.id)) {
        ops.push(createService(fields));
        return;
      }
      const orig = services.find((o) => o.id === s.id);
      if (
        orig.name !== s.name ||
        orig.price !== s.price ||
        orig.duration !== s.duration ||
        orig.sort !== fields.sort
      ) {
        ops.push(updateService(s.id, fields));
      }
    });

    const results = await Promise.all(ops);
    const failed = results.find((r) => !r.ok);
    if (failed) {
      onError(failed.error);
      return;
    }
    setDraft(null);
    onToast("Услуги сохранены — клиенты видят новый список.");
  };

  const save = () => {
    if (busy) return;
    const cleaned = list
      .map((s) => ({
        ...s,
        name: String(s.name).trim(),
        price: Math.max(0, Math.round(Number(s.price) || 0)),
        duration: Math.max(15, Math.round(Number(s.duration) || 0)),
      }))
      .filter((s) => s.name !== "");

    for (const s of cleaned) {
      const err = validateServiceFields(s);
      if (err) {
        setFieldError(`«${s.name}»: ${err}`);
        return;
      }
    }
    setFieldError("");

    busyThen("save", 700, () => commitSvc(cleaned));
  };

  return (
    <div>
      <p className="eyebrow">Услуги и цены</p>
      <div className="services-panel">
        {list.map((s, i) => (
          <div
            className={overId === s.id ? "service-row drop-target" : "service-row"}
            key={s.id}
            data-testid={`service-row-${s.id}`}
            onDragOver={(e) => {
              // Тащат не нашу ручку (например, выделенный текст из поля) — не цель.
              if (!dragId.current) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overId !== s.id) setOverId(s.id);
            }}
            onDrop={(e) => {
              if (!dragId.current) return;
              e.preventDefault();
              move(
                list.findIndex((x) => x.id === dragId.current),
                i
              );
              endDrag();
            }}
          >
            <span className="service-order">
              <button
                className="service-order-btn"
                type="button"
                aria-label="Выше"
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                <Icon name="chevronUp" size={16} />
              </button>
              <span
                className="service-grip"
                draggable="true"
                title="Перетащите, чтобы изменить порядок"
                onDragStart={(e) => {
                  dragId.current = s.id;
                  e.dataTransfer.effectAllowed = "move";
                  // Без setData Firefox не начинает перетаскивание.
                  e.dataTransfer.setData("text/plain", s.id);
                  const row = e.currentTarget.closest(".service-row");
                  if (row) e.dataTransfer.setDragImage(row, 20, 20);
                }}
                onDragEnd={endDrag}
              >
                <Icon name="grip" size={16} />
              </span>
              <button
                className="service-order-btn"
                type="button"
                aria-label="Ниже"
                disabled={i === list.length - 1}
                onClick={() => move(i, i + 1)}
              >
                <Icon name="chevronDown" size={16} />
              </button>
            </span>
            <span className="service-fields">
              <span className="service-name-row">
                <input
                  type="text"
                  className="mini-field grow"
                  placeholder="Название услуги"
                  aria-label="Название услуги"
                  value={s.name}
                  onChange={(e) => edit(s.id, "name", e.target.value)}
                />
                <button
                  className="remove-btn"
                  type="button"
                  aria-label="Удалить услугу"
                  onClick={() => remove(s.id)}
                >
                  <Icon name="x" size={15} />
                </button>
              </span>
              <span className="service-meta-row">
                <span className="unit-group">
                  <input
                    type="number"
                    inputMode="numeric"
                    step="15"
                    min="15"
                    className="mini-field unit-input duration"
                    aria-label="Длительность"
                    value={s.duration}
                    onChange={(e) => edit(s.id, "duration", e.target.value)}
                  />
                  <span className="unit-suffix">мин</span>
                </span>
                <span className="unit-group">
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    className="mini-field unit-input price"
                    aria-label="Цена"
                    value={s.price}
                    onChange={(e) => edit(s.id, "price", e.target.value)}
                  />
                  <span className="unit-suffix">{CURRENCY}</span>
                </span>
              </span>
            </span>
          </div>
        ))}

        <button className="add-service-btn" type="button" onClick={add}>
          <Icon name="plus" size={16} />
          Добавить услугу
        </button>

        {fieldError && <p className="form-error">{fieldError}</p>}

        <div className="services-foot">
          <span className="services-note">
            {dirty
              ? "Есть несохранённые изменения."
              : "Список и цены сразу видны клиентам в разделе «Услуги и цены»."}
          </span>
          {dirty && (
            <button className="btn-cancel-draft" type="button" onClick={reset}>
              Отменить
            </button>
          )}
          <button className="btn-save" type="button" disabled={!dirty || !!busy} onClick={save}>
            {busy === "save" && <span className="btn-spinner" aria-hidden="true" />}
            {busy === "save" ? "Сохраняем" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
