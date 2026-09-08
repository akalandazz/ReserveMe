import { useState } from "react";
import { signIn } from "../../supabase.js";

/**
 * Форма входа мастера. В отличие от клиентской кнопки-в-теле-экрана
 * (см. CLAUDE.md про AdminScreen) здесь тоже вся страница — один
 * скролл без липкой нижней панели, так что сдвиг клавиатурой не
 * страшен, но паттерн «кнопка рядом с полями» тот же самый.
 */
export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await signIn(email, password);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className="signin-wrap">
      <h1 className="title">Кабинет мастера</h1>
      <p className="sub">Войдите, чтобы управлять расписанием и ценами.</p>

      <label className="eyebrow" htmlFor="admin-email">
        E-mail
      </label>
      <input
        id="admin-email"
        className="field"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={onKeyDown}
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
        onKeyDown={onKeyDown}
      />

      {error && <p className="form-error">{error}</p>}

      <button
        className="btn-primary inline"
        type="button"
        onClick={submit}
        disabled={busy}
      >
        {busy ? "Входим…" : "Войти"}
      </button>
    </div>
  );
}
