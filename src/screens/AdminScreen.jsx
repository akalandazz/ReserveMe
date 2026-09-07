// Админка мастера: вход, меню разделов и диспетчер шагов.
//
// Все шаги admin:* рендерят ОДИН И ТОТ ЖЕ компонент на одной позиции,
// поэтому React сохраняет инстанс и выбранная услуга переживает переход
// между списком и формой — так же, как BookingScreen держит своё
// состояние через четыре шага записи.
//
// ⚠️ Здесь нельзя вызывать sendToMaster: openTelegramLink закрывает
// мини-апп, и несохранённая правка потеряется.

import { useState } from "react";
import { useContent } from "../content.js";
import { useSession, signIn, signOut, SUPABASE_READY } from "../supabase.js";
import {
  NavRow,
  PrimaryButton,
  Screen,
  TextButton,
  Title,
} from "../ui.jsx";
import AdminContact from "./admin/AdminContact.jsx";
import AdminInfo from "./admin/AdminInfo.jsx";
import AdminSchedule from "./admin/AdminSchedule.jsx";
import AdminServiceForm from "./admin/AdminServiceForm.jsx";
import AdminServices from "./admin/AdminServices.jsx";

const CRUMB = "Настройки";

const SECTIONS = [
  { id: "admin:services", icon: "sparkle", label: "Услуги и цены" },
  { id: "admin:schedule", icon: "clock", label: "График работы" },
  { id: "admin:contact", icon: "chat", label: "Контакты и адрес" },
  { id: "admin:info", icon: "info", label: "Важная информация" },
];

function SignIn({ onBack }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await signIn(email, password);
    setBusy(false);
    if (!res.ok) setError(res.error);
    // при успехе onAuthStateChange сам перерисует экран
  };

  return (
    <Screen crumb={CRUMB} onBack={onBack}>
      <Title>Вход</Title>
      <p className="sub">Раздел для мастера</p>

      {!SUPABASE_READY && (
        <p className="notice">
          Не заданы VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY. Впишите их
          в файл .env и пересоберите приложение.
        </p>
      )}

      <label className="eyebrow" htmlFor="admin-email">
        E-mail
      </label>
      <input
        id="admin-email"
        className="field"
        type="email"
        inputMode="email"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <label className="eyebrow" htmlFor="admin-password">
        Пароль
      </label>
      <input
        id="admin-password"
        className="field"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />

      {error && <p className="form-error">{error}</p>}

      {/* Кнопка в теле, а не в липком футере: клавиатура Telegram
          накрыла бы футером то самое поле, в которое печатают. */}
      <PrimaryButton inline onClick={submit} disabled={busy}>
        {busy ? "Входим…" : "Войти"}
      </PrimaryButton>
    </Screen>
  );
}

export default function AdminScreen({ step, push, back, home }) {
  const session = useSession();
  const content = useContent();
  // null — создаём новую услугу; объект — редактируем существующую.
  const [editing, setEditing] = useState(null);

  if (session.status === "unknown") {
    return (
      <Screen crumb={CRUMB} onBack={back}>
        <div className="blank tall">Загрузка…</div>
      </Screen>
    );
  }

  if (session.status !== "signed") {
    return <SignIn onBack={back} />;
  }

  if (step === "admin:services") {
    return (
      <AdminServices
        services={content.services}
        onBack={back}
        onEdit={(s) => {
          setEditing(s);
          push("admin:service");
        }}
        onAdd={() => {
          setEditing(null);
          push("admin:service");
        }}
      />
    );
  }

  if (step === "admin:service") {
    return (
      <AdminServiceForm
        initial={editing}
        services={content.services}
        onBack={back}
        onDone={back}
      />
    );
  }

  // Админка открывается ДО гейта загрузки — иначе пустая база заперла бы
  // единственный экран, которым её можно починить. Значит, здесь settings
  // может не быть, и разделы, которым он нужен, обязаны это пережить.
  if (step === "admin:schedule" || step === "admin:contact") {
    if (!content.settings) {
      return (
        <Screen crumb={CRUMB} onBack={back}>
          <Title>Нет данных</Title>
          <p className="notice">
            {content.error ??
              "Не удалось загрузить настройки салона."}
          </p>
          <p className="admin-hint">
            Если база только что создана — выполните supabase/schema.sql:
            в таблице settings должна быть строка с id = 1.
          </p>
        </Screen>
      );
    }
    return step === "admin:schedule" ? (
      <AdminSchedule
        settings={content.settings}
        daysOff={content.daysOff}
        onBack={back}
      />
    ) : (
      <AdminContact settings={content.settings} onBack={back} />
    );
  }

  if (step === "admin:info") {
    return <AdminInfo blocks={content.infoBlocks} onBack={back} />;
  }

  // step === "admin"
  return (
    <Screen crumb={CRUMB} onBack={back}>
      <Title>Настройки</Title>
      <p className="sub">{session.email}</p>

      {content.stale && (
        <p className="notice">
          Показаны сохранённые данные — не удалось связаться с сервером.
          Изменения сейчас не сохранятся.
        </p>
      )}

      <div className="panel nav">
        {SECTIONS.map((s) => (
          <NavRow
            key={s.id}
            icon={s.icon}
            label={s.label}
            onClick={() => push(s.id)}
          />
        ))}
      </div>

      <TextButton
        onClick={async () => {
          await signOut();
          home();
        }}
      >
        Выйти
      </TextButton>
    </Screen>
  );
}
