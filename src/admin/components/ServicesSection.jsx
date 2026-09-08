import { useState } from "react";
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
 */
export default function ServicesSection({ services, onToast, onError }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState("");

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
  const reset = () => {
    setDraft(null);
    setFieldError("");
  };

  const save = async () => {
    if (saving) return;
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

    const originalIds = new Set(services.map((s) => s.id));
    const draftIds = new Set(cleaned.map((s) => s.id));
    const ops = [];
    for (const s of services) {
      if (!draftIds.has(s.id)) ops.push(deleteService(s.id));
    }
    for (const s of cleaned) {
      const fields = { name: s.name, price: s.price, duration: s.duration };
      if (!originalIds.has(s.id)) {
        ops.push(createService(fields));
        continue;
      }
      const orig = services.find((o) => o.id === s.id);
      if (orig.name !== s.name || orig.price !== s.price || orig.duration !== s.duration) {
        ops.push(updateService(s.id, fields));
      }
    }

    setSaving(true);
    const results = await Promise.all(ops);
    setSaving(false);
    const failed = results.find((r) => !r.ok);
    if (failed) {
      onError(failed.error);
      return;
    }
    setDraft(null);
    onToast("Услуги сохранены — клиенты видят новый список.");
  };

  return (
    <div>
      <p className="eyebrow">Услуги и цены</p>
      <div className="services-panel">
        {list.map((s) => (
          <div className="service-row" key={s.id}>
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
                  <span className="unit-suffix">₾</span>
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
          <button className="btn-save" type="button" disabled={!dirty || saving} onClick={save}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
