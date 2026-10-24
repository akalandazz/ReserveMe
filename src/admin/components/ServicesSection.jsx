import { useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CURRENCY } from "../../money.js";
import {
  createService,
  deleteService,
  updateService,
  validateServiceFields,
} from "../api.js";
import { Icon } from "./Icons.jsx";

// Строка ездит только по вертикали — без @dnd-kit/modifiers ради одной строки.
const vertical = ({ transform }) => ({ ...transform, x: 0 });

// Подсказки скринридеру — по-русски, у dnd-kit по умолчанию английские.
const nameOf = (list, id) => list.find((s) => s.id === id)?.name || "Услуга";
const position = (list, id) => list.findIndex((s) => s.id === id) + 1;

/**
 * Только name/duration/price — так в макете. emoji/note/active из
 * прежней админки сюда не входят: правки этих трёх полей не трогают
 * остальные колонки, а создание новой услуги берёт их значения по
 * умолчанию (см. supabase/schema.sql).
 *
 * Порядок массива — порядок услуг везде (services.sort = индекс + 1,
 * клиент читает order by sort). Перетаскивание меняет только черновик,
 * как и правка полей: «Отменить» возвращает прежний порядок.
 * Перетаскивание — @dnd-kit: один PointerSensor и для мыши, и для пальца
 * (нативный HTML5 drag на телефоне не срабатывает). Тянет только ручка
 * (touch-action: none в admin.css), поля ввода и выделение текста — как были.
 */
export default function ServicesSection({ services, busy, busyThen, onToast, onError }) {
  const [draft, setDraft] = useState(null);
  const [fieldError, setFieldError] = useState("");

  const list = draft ?? services;
  const dirty = draft !== null;

  const sensors = useSensors(
    // 4 px — чтобы клик по ручке не считался перетаскиванием.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

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
  const onDragEnd = ({ active, over }) => {
    if (!over) return;
    move(
      list.findIndex((s) => s.id === active.id),
      list.findIndex((s) => s.id === over.id)
    );
  };
  const reset = () => {
    setDraft(null);
    setFieldError("");
  };

  const announcements = {
    onDragStart: ({ active }) => `Взята «${nameOf(list, active.id)}»`,
    onDragOver: ({ active, over }) =>
      over ? `«${nameOf(list, active.id)}» — на место ${position(list, over.id)}` : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `«${nameOf(list, active.id)}» перенесена на место ${position(list, over.id)}` : undefined,
    onDragCancel: ({ active }) => `Перенос «${nameOf(list, active.id)}» отменён`,
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[vertical]}
          onDragEnd={onDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable:
                "Пробел — взять услугу, стрелки — переместить, пробел — поставить, Esc — отменить.",
            },
          }}
        >
          <SortableContext items={list.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {list.map((s) => (
              <ServiceRow key={s.id} service={s} onEdit={edit} onRemove={remove} />
            ))}
          </SortableContext>
        </DndContext>

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

function ServiceRow({ service: s, onEdit, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: s.id });

  let className = "service-row";
  if (isDragging) className += " dragging";
  else if (isOver) className += " drop-target";

  return (
    <div
      ref={setNodeRef}
      className={className}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`service-row-${s.id}`}
    >
      <span
        ref={setActivatorNodeRef}
        className="service-grip"
        title="Перетащите, чтобы изменить порядок"
        {...attributes}
        aria-label={`Перетащить «${s.name || "услугу"}»`}
        {...listeners}
      >
        <Icon name="grip" size={18} />
      </span>
      <span className="service-fields">
        <span className="service-name-row">
          <input
            type="text"
            className="mini-field grow"
            placeholder="Название услуги"
            aria-label="Название услуги"
            value={s.name}
            onChange={(e) => onEdit(s.id, "name", e.target.value)}
          />
          <button
            className="remove-btn"
            type="button"
            aria-label="Удалить услугу"
            onClick={() => onRemove(s.id)}
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
              onChange={(e) => onEdit(s.id, "duration", e.target.value)}
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
              onChange={(e) => onEdit(s.id, "price", e.target.value)}
            />
            <span className="unit-suffix">{CURRENCY}</span>
          </span>
        </span>
      </span>
    </div>
  );
}
