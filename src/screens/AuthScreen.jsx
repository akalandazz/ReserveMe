import { useState } from "react";
import { signIn, signUp } from "../supabase.js";
import { PrimaryButton, Screen, TextButton, Title } from "../ui.jsx";

// Минимум Supabase по умолчанию — проверяем до запроса, чтобы не гонять сеть.
const MIN_PASSWORD = 6;

/**
 * Вход и регистрация клиента — единственный экран мини-аппа до входа
 * (гейт в App.jsx). Кнопка — в теле экрана, а не в липкой нижней панели,
 * как у формы входа кабинета: при открытой клавиатуре Telegram панель
 * легла бы прямо на поле пароля.
 *
 * Роль 'user' ставит не экран, а src/supabase.js, как только появится
 * сессия; после успешного входа App.jsx сам перерисует дерево.
 */
export default function AuthScreen() {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const isSignUp = mode === "signup";

  const switchMode = () => {
    setMode(isSignUp ? "signin" : "signup");
    setError("");
    setRepeat("");
    setSent(false);
  };

  const submit = async () => {
    if (busy) return;
    if (!email.trim() || !password) {
      setError("Заполните e-mail и пароль");
      return;
    }
    if (isSignUp && password.length < MIN_PASSWORD) {
      setError(`Пароль — минимум ${MIN_PASSWORD} символов`);
      return;
    }
    if (isSignUp && password !== repeat) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    setError("");
    const res = isSignUp ? await signUp(email, password) : await signIn(email, password);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // С сессией экран сменится сам. Без неё — ждём подтверждения e-mail.
    if (res.needsConfirm) {
      setSent(true);
      setMode("signin");
      setPassword("");
      setRepeat("");
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") submit();
  };

  return (
    <Screen crumb={isSignUp ? "Регистрация" : "Вход"}>
      <Title>{isSignUp ? "Регистрация" : "Вход"}</Title>
      <p className="sub">
        {isSignUp
          ? "Создайте аккаунт, чтобы записываться и видеть свои записи."
          : "Войдите, чтобы записаться к мастеру."}
      </p>

      {sent && (
        <p className="notice" role="status">
          Мы отправили письмо на {email.trim()}. Откройте ссылку из него, а
          потом войдите здесь.
        </p>
      )}

      <label className="eyebrow" htmlFor="auth-email">
        E-mail
      </label>
      <input
        id="auth-email"
        className="field"
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <label className="eyebrow" htmlFor="auth-password">
        Пароль
      </label>
      <input
        id="auth-password"
        className="field"
        type="password"
        autoComplete={isSignUp ? "new-password" : "current-password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={onKeyDown}
      />

      {isSignUp && (
        <>
          <label className="eyebrow" htmlFor="auth-repeat">
            Повторите пароль
          </label>
          <input
            id="auth-repeat"
            className="field"
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <PrimaryButton inline disabled={busy} onClick={submit}>
        {busy
          ? isSignUp
            ? "Создаём…"
            : "Входим…"
          : isSignUp
            ? "Зарегистрироваться"
            : "Войти"}
      </PrimaryButton>

      <TextButton onClick={switchMode}>
        {isSignUp ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Зарегистрироваться"}
      </TextButton>
    </Screen>
  );
}
