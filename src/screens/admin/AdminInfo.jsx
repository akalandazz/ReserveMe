import { useState } from "react";
import {
  deleteInfoBlock,
  reorderInfoBlocks,
  saveInfoBlock,
} from "../../content.js";
import { haptic, showConfirm } from "../../telegram.js";
import {
  Icon,
  PrimaryButton,
  Screen,
  TextButton,
  Title,
} from "../../ui.jsx";

const BLANK = { id: null, emoji: "", title: "", body: "" };

export default function AdminInfo({ blocks, onBack }) {
  // Блок маленький (эмодзи, заголовок, текст) — правим прямо здесь,
  // отдельный экран ради трёх полей не нужен.
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (key) => (e) =>
    setEditing((prev) => ({ ...prev, [key]: e.target.value }));

  const move = async (i, dir) => {
    const j = i + dir;
    if (busy || j < 0 || j >= blocks.length) return;
    const ids = blocks.map((b) => b.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];

    setBusy(true);
    setError("");
    const res = await reorderInfoBlocks(ids);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  const save = async () => {
    if (busy) return;
    const title = editing.title.trim();
    const body = editing.body.trim();
    if (!title) return setError("Введите заголовок");
    if (title.length > 60) return setError("Заголовок слишком длинный");
    if (!body) return setError("Введите текст");
    if (body.length > 600) return setError("Текст слишком длинный");

    setBusy(true);
    setError("");
    const res = await saveInfoBlock({
      id: editing.id,
      emoji: [...editing.emoji.trim()].slice(0, 4).join(""),
      title,
      body,
      sort: editing.sort,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    haptic("success");
    setEditing(null);
  };

  const remove = (block) => {
    showConfirm(`Удалить блок «${block.title}»?`, async (ok) => {
      if (!ok) return;
      haptic("warning");
      setBusy(true);
      const res = await deleteInfoBlock(block.id);
      setBusy(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEditing(null);
    });
  };

  if (editing) {
    return (
      <Screen
        crumb="Информация"
        onBack={() => setEditing(null)}
        footer={
          <PrimaryButton onClick={save} disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </PrimaryButton>
        }
      >
        <Title>{editing.id ? "Изменить блок" : "Новый блок"}</Title>

        <label className="eyebrow" htmlFor="inf-emoji">
          Эмодзи
        </label>
        <input
          id="inf-emoji"
          className="field is-emoji"
          type="text"
          maxLength={8}
          value={editing.emoji}
          onChange={set("emoji")}
        />

        <label className="eyebrow" htmlFor="inf-title">
          Заголовок
        </label>
        <input
          id="inf-title"
          className="field"
          type="text"
          maxLength={60}
          value={editing.title}
          onChange={set("title")}
        />

        <label className="eyebrow" htmlFor="inf-body">
          Текст
        </label>
        <textarea
          id="inf-body"
          className="field"
          rows={5}
          maxLength={600}
          value={editing.body}
          onChange={set("body")}
        />

        {error && <p className="form-error">{error}</p>}

        {editing.id && (
          <TextButton danger onClick={() => remove(editing)}>
            Удалить блок
          </TextButton>
        )}
      </Screen>
    );
  }

  return (
    <Screen
      crumb="Информация"
      onBack={onBack}
      footer={
        <PrimaryButton
          onClick={() => {
            setError("");
            setEditing(BLANK);
          }}
        >
          Добавить блок
        </PrimaryButton>
      }
    >
      <Title>Важная информация</Title>
      <p className="sub">Блоки на одноимённом экране у клиентов</p>

      <div className="divided">
        {blocks.map((b, i) => (
          <div key={b.id} className="admin-row">
            <span className="list-main">
              <span className="list-title">{b.title}</span>
              <span className="list-meta">{b.body}</span>
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
                disabled={busy || i === blocks.length - 1}
                onClick={() => move(i, 1)}
              >
                <Icon name="down" size={16} />
              </button>
              <button
                className="icon-btn"
                type="button"
                aria-label={`Изменить «${b.title}»`}
                onClick={() => {
                  setError("");
                  setEditing({ ...b });
                }}
              >
                <Icon name="pencil" size={16} />
              </button>
            </span>
          </div>
        ))}
      </div>

      {blocks.length === 0 && <div className="blank tall">Блоков пока нет</div>}

      {error && <p className="form-error">{error}</p>}
    </Screen>
  );
}
