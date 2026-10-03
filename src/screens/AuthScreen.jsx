import { signInWithTelegram } from "../supabase.js";
import { PrimaryButton, Screen, Title } from "../ui.jsx";

/**
 * Гейт мини-аппа до входа (App.jsx). Формы нет: вход — через Telegram,
 * src/supabase.js сам отправляет initData при запуске. Экран только
 * объясняет, почему вход не случился, и даёт попробовать снова. Кнопка —
 * в теле экрана, как у прежней формы входа.
 */
export default function AuthScreen({ session }) {
  if (session.status === "no-telegram") {
    return (
      <Screen crumb="Вход">
        <Title>Откройте в Telegram</Title>
        <p className="sub">
          Запись работает только внутри Telegram — откройте приложение из чата
          с ботом салона.
        </p>
      </Screen>
    );
  }

  const failed = session.status === "error";
  return (
    <Screen crumb="Вход">
      <Title>{failed ? "Не удалось войти" : "Вы вышли"}</Title>
      <p className="sub" role={failed ? "alert" : undefined}>
        {failed ? session.error : "Войдите снова, чтобы записаться и видеть свои записи."}
      </p>
      <PrimaryButton inline onClick={signInWithTelegram}>
        {failed ? "Повторить" : "Войти снова"}
      </PrimaryButton>
    </Screen>
  );
}
