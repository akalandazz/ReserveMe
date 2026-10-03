import { useState } from "react";
import { consentParagraphs, POLICY_DATE } from "../legal.js";
import { acceptConsent, signInWithTelegram } from "../supabase.js";
import { PrimaryButton, Screen, TextButton, Title } from "../ui.jsx";
import { PolicyText } from "./PrivacyScreen.jsx";

/**
 * Согласие на обработку ПДн (152-ФЗ, ст. 9) — до входа: telegram-auth не
 * заводит аккаунт, пока его нет. Текст согласия — отдельно от политики;
 * политику можно прочитать здесь же, до «Согласен». Кнопки «назад» Telegram
 * до входа нет (App.jsx), поэтому из политики назад ведёт кнопка в подвале.
 */
function ConsentScreen() {
  const [reading, setReading] = useState(false);

  if (reading) {
    return (
      <Screen
        crumb="Персональные данные"
        onBack={() => setReading(false)}
        footer={<PrimaryButton onClick={() => setReading(false)}>Назад к согласию</PrimaryButton>}
      >
        <Title>Политика обработки персональных данных</Title>
        <p className="sub">Редакция от {POLICY_DATE}</p>
        <PolicyText />
      </Screen>
    );
  }

  return (
    <Screen
      crumb="Вход"
      footer={<PrimaryButton onClick={acceptConsent}>Согласен</PrimaryButton>}
    >
      <Title>Согласие на обработку персональных данных</Title>
      <div className="legal">
        {consentParagraphs().map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      <TextButton onClick={() => setReading(true)}>
        Политика обработки персональных данных
      </TextButton>
      <p className="note">
        Без согласия запись через приложение недоступна — можно записаться,
        написав мастеру в Telegram.
      </p>
    </Screen>
  );
}

/**
 * Гейт мини-аппа до входа (App.jsx). Формы нет: вход — через Telegram,
 * src/supabase.js сам отправляет initData при запуске. Экран только
 * объясняет, почему вход не случился, и даёт попробовать снова. Кнопка —
 * в теле экрана, как у прежней формы входа.
 */
export default function AuthScreen({ session }) {
  if (session.status === "consent") return <ConsentScreen />;

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
