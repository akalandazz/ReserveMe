import { useState } from "react";
import {
  createService,
  deleteService,
  slugify,
  updateService,
  validateService,
} from "../../content.js";
import { haptic, showConfirm } from "../../telegram.js";
import {
  OptionRow,
  PrimaryButton,
  Screen,
  TextButton,
  Title,
} from "../../ui.jsx";

const BLANK = {
  id: "",
  emoji: "💅",
  name: "",
  price: "",
  duration: "60",
  note: "",
  active: true,
};

export default function AdminServiceForm({
  initial,
  services,
  onBack,
  onDone,
}) {
  const isNew = !initial;
  const [f, setF] = useState(() =>
    initial
      ? {
          id: initial.id,
          emoji: initial.emoji,
          name: initial.name,
          price: String(initial.price),
          duration: String(initial.duration),
          note: initial.note,
          active: initial.active,
        }
      : BLANK
  );
  // Пока идентификатор не правили руками — подставляем его из названия.
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Занятые id — включая скрытые услуги: переиспользовать нельзя ни один.
  const taken = services
    .map((s) => s.id)
    .filter((id) => isNew || id !== initial.id);

  const set = (key) => (value) => setF((prev) => ({ ...prev, [key]: value }));

  const setName = (value) => {
    setF((prev) => ({
      ...prev,
      name: value,
      id: isNew && !idTouched ? slugify(value, taken) : prev.id,
    }));
  };

  const save = async () => {
    if (busy) return;
    // Проверяем то, что напечатали: "abc" должно дать понятную ошибку,
    // а не молча превратиться в NaN.
    const problem = validateService(f, taken);
    if (problem) {
      setError(problem);
      return;
    }

    const fields = {
      ...f,
      // ⚠️ input type="number" отдаёт строку: без Number цена уехала бы
      // в сохранённую заявку клиента как "70".
      price: Number(f.price),
      duration: Number(f.duration),
      name: f.name.trim(),
      note: f.note.trim(),
      // [...] по кодовым точкам: slice разрезал бы суррогатную пару.
      emoji: [...f.emoji.trim()].slice(0, 4).join("") || "💅",
    };

    setBusy(true);
    setError("");
    const res = isNew
      ? await createService(fields)
      : await updateService(initial.id, fields);
    setBusy(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }
    haptic("success");
    onDone();
  };

  const remove = () => {
    showConfirm(
      `Удалить «${f.name}»? Прошлые записи клиентов потеряют название. ` +
        `Обычно достаточно скрыть услугу.`,
      async (ok) => {
        if (!ok) return;
        haptic("warning");
        setBusy(true);
        const res = await deleteService(initial.id);
        setBusy(false);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onDone();
      }
    );
  };

  return (
    <Screen
      crumb="Услуга"
      onBack={onBack}
      footer={
        <PrimaryButton onClick={save} disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить"}
        </PrimaryButton>
      }
    >
      <Title>{isNew ? "Новая услуга" : "Изменить услугу"}</Title>

      <label className="eyebrow" htmlFor="svc-name">
        Название
      </label>
      <input
        id="svc-name"
        className="field"
        type="text"
        maxLength={80}
        value={f.name}
        onChange={(e) => setName(e.target.value)}
      />

      <div className="form-grid">
        <div>
          <label className="eyebrow" htmlFor="svc-price">
            Цена, ₾
          </label>
          <input
            id="svc-price"
            className="field"
            type="number"
            inputMode="numeric"
            min="0"
            max="9999"
            step="1"
            value={f.price}
            onChange={(e) => set("price")(e.target.value)}
          />
        </div>
        <div>
          <label className="eyebrow" htmlFor="svc-duration">
            Минут
          </label>
          <input
            id="svc-duration"
            className="field"
            type="number"
            inputMode="numeric"
            min="15"
            max="600"
            step="15"
            value={f.duration}
            onChange={(e) => set("duration")(e.target.value)}
          />
        </div>
      </div>
      <p className="admin-hint">Длительность — кратно 15 минутам.</p>

      <label className="eyebrow" htmlFor="svc-note">
        Описание
      </label>
      <textarea
        id="svc-note"
        className="field"
        rows={2}
        maxLength={120}
        value={f.note}
        onChange={(e) => set("note")(e.target.value)}
      />

      <label className="eyebrow" htmlFor="svc-emoji">
        Эмодзи
      </label>
      <input
        id="svc-emoji"
        className="field is-emoji"
        type="text"
        maxLength={8}
        value={f.emoji}
        onChange={(e) => set("emoji")(e.target.value)}
      />
      <p className="admin-hint">
        В приложении не показывается — только в сообщении, которое клиент
        присылает вам в чат.
      </p>

      <label className="eyebrow" htmlFor="svc-id">
        Идентификатор
      </label>
      <input
        id="svc-id"
        className="field"
        type="text"
        disabled={!isNew}
        value={f.id}
        onChange={(e) => {
          setIdTouched(true);
          set("id")(e.target.value.trim().toLowerCase());
        }}
      />
      <p className="admin-hint">
        {isNew
          ? "Латиницей, без пробелов. Подставляется из названия — можно поправить."
          : "Менять нельзя: по нему находятся уже сохранённые записи клиентов."}
      </p>

      <p className="eyebrow">Видимость</p>
      <div className="stack tight">
        <OptionRow
          wide
          title={f.active ? "Показывается клиентам" : "Скрыта от клиентов"}
          meta={
            f.active
              ? "Нажмите, чтобы скрыть"
              : "Нажмите, чтобы вернуть в прайс"
          }
          selected={f.active}
          onClick={() => set("active")(!f.active)}
        />
      </div>

      {error && <p className="form-error">{error}</p>}

      {!isNew && (
        <TextButton danger onClick={remove}>
          Удалить услугу
        </TextButton>
      )}
    </Screen>
  );
}
