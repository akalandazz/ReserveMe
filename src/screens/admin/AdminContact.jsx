import { useState } from "react";
import { saveSettings, validateSettings } from "../../content.js";
import { haptic, openLink } from "../../telegram.js";
import { PrimaryButton, Screen, TextButton, Title } from "../../ui.jsx";

export default function AdminContact({ settings, onBack }) {
  const [f, setF] = useState(() => ({
    masterName: settings.masterName,
    masterUsername: settings.masterUsername,
    masterPhone: settings.masterPhone,
    address: settings.location.address,
    landmark: settings.location.landmark,
    transport: settings.location.transport,
    mapUrl: settings.location.mapUrl,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (key) => (e) =>
    setF((prev) => ({ ...prev, [key]: e.target.value }));

  const save = async () => {
    if (busy) return;
    const next = {
      ...settings,
      masterName: f.masterName.trim(),
      // @ и пробелы — самая частая опечатка в этом поле
      masterUsername: f.masterUsername.trim().replace(/^@/, ""),
      masterPhone: f.masterPhone.trim(),
      location: {
        address: f.address.trim(),
        landmark: f.landmark.trim(),
        transport: f.transport.trim(),
        mapUrl: f.mapUrl.trim(),
      },
    };

    const problem = validateSettings(next);
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    setError("");
    const res = await saveSettings(next);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else haptic("success");
  };

  const username = f.masterUsername.trim().replace(/^@/, "");

  return (
    <Screen
      crumb="Контакты"
      onBack={onBack}
      footer={
        <PrimaryButton onClick={save} disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить"}
        </PrimaryButton>
      }
    >
      <Title>Контакты и адрес</Title>

      <label className="eyebrow" htmlFor="ct-name">
        Имя мастера
      </label>
      <input
        id="ct-name"
        className="field"
        type="text"
        maxLength={40}
        value={f.masterName}
        onChange={set("masterName")}
      />

      <label className="eyebrow" htmlFor="ct-username">
        Telegram-логин, без @
      </label>
      <input
        id="ct-username"
        className="field"
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={32}
        value={f.masterUsername}
        onChange={set("masterUsername")}
      />
      {username ? (
        <TextButton onClick={() => openLink(`https://t.me/${username}`)}>
          Проверить ссылку t.me/{username}
        </TextButton>
      ) : (
        <p className="notice">
          Без логина кнопки «Отправить заявку» не работают — заявки клиентов
          вам не придут.
        </p>
      )}

      <label className="eyebrow" htmlFor="ct-phone">
        Телефон
      </label>
      <input
        id="ct-phone"
        className="field"
        type="tel"
        value={f.masterPhone}
        onChange={set("masterPhone")}
      />
      <p className="admin-hint">Пустое поле — телефон не показывается.</p>

      <label className="eyebrow" htmlFor="ct-address">
        Адрес
      </label>
      <input
        id="ct-address"
        className="field"
        type="text"
        value={f.address}
        onChange={set("address")}
      />

      <label className="eyebrow" htmlFor="ct-landmark">
        Как войти
      </label>
      <textarea
        id="ct-landmark"
        className="field"
        rows={2}
        value={f.landmark}
        onChange={set("landmark")}
      />

      <label className="eyebrow" htmlFor="ct-transport">
        Как добраться
      </label>
      <textarea
        id="ct-transport"
        className="field"
        rows={2}
        value={f.transport}
        onChange={set("transport")}
      />

      <label className="eyebrow" htmlFor="ct-map">
        Ссылка на карту
      </label>
      <input
        id="ct-map"
        className="field"
        type="url"
        autoCapitalize="none"
        spellCheck={false}
        value={f.mapUrl}
        onChange={set("mapUrl")}
      />
      <p className="admin-hint">
        Пустое поле — кнопка «Открыть на карте» не показывается.
      </p>

      {error && <p className="form-error">{error}</p>}
    </Screen>
  );
}
