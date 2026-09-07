import { useState } from "react";
import { reorderServices } from "../../content.js";
import { Icon, PrimaryButton, Screen, Title } from "../../ui.jsx";

export default function AdminServices({ services, onBack, onEdit, onAdd }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const move = async (i, dir) => {
    const j = i + dir;
    if (busy || j < 0 || j >= services.length) return;
    const ids = services.map((s) => s.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];

    setBusy(true);
    setError("");
    const res = await reorderServices(ids);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  return (
    <Screen
      crumb="Услуги"
      onBack={onBack}
      footer={<PrimaryButton onClick={onAdd}>Добавить услугу</PrimaryButton>}
    >
      <Title>Услуги и цены</Title>
      <p className="sub">Порядок в списке — такой же, как у клиентов</p>

      <div className="divided">
        {services.map((s, i) => (
          <div key={s.id} className={s.active ? "admin-row" : "admin-row off"}>
            <span className="list-main">
              <span className="list-title">{s.name}</span>
              <span className="list-meta">
                {s.price} ₾ · {s.duration} мин{s.active ? "" : " · скрыта"}
              </span>
            </span>
            <span className="admin-actions">
              <button
                className="icon-btn"
                type="button"
                aria-label="Поднять выше"
                disabled={busy || i === 0}
                onClick={() => move(i, -1)}
              >
                <Icon name="up" size={16} />
              </button>
              <button
                className="icon-btn"
                type="button"
                aria-label="Опустить ниже"
                disabled={busy || i === services.length - 1}
                onClick={() => move(i, 1)}
              >
                <Icon name="down" size={16} />
              </button>
              <button
                className="icon-btn"
                type="button"
                aria-label={`Изменить «${s.name}»`}
                onClick={() => onEdit(s)}
              >
                <Icon name="pencil" size={16} />
              </button>
            </span>
          </div>
        ))}
      </div>

      {services.length === 0 && (
        <div className="blank tall">Услуг пока нет</div>
      )}

      {error && <p className="form-error">{error}</p>}

      <p className="admin-hint">
        Скрытая услуга исчезает из прайса и записи, но её название
        по-прежнему видно в старых заявках клиентов.
      </p>
    </Screen>
  );
}
