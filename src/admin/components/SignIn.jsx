import { consentParagraphs } from "../../legal.js";
import { acceptConsent, signInWithTelegram } from "../../supabase.js";
import { openLink } from "../../telegram.js";

// Рядом с admin.html, в той же сборке (vite.config.js) — относительный
// адрес переживает деплой не в корень домена.
const openPolicy = () => openLink(new URL("privacy.html", window.location.href).href);

/**
 * Гейт кабинета до входа. Формы нет: вход — через Telegram (src/supabase.js
 * отправляет initData при запуске), кабинет открывается только как мини-апп —
 * на телефоне или в Telegram Desktop. В обычном браузере входить нечем.
 * Кнопка — рядом с текстом, как у прежней формы входа.
 *
 * Согласие на обработку ПДн telegram-auth требует от всех, мастера тоже:
 * первый вход мастера заводит такой же аккаунт, как у клиента. Политика —
 * отдельной страницей privacy.html: клиентские экраны сюда не импортируются.
 */
export default function SignIn({ session }) {
  if (session.status === "consent") {
    return (
      <div className="signin-wrap">
        <h1 className="title">Согласие на обработку персональных данных</h1>
        {consentParagraphs().map((p) => (
          <p key={p} className="sub">
            {p}
          </p>
        ))}
        <button className="btn-text" type="button" onClick={openPolicy}>
          Политика обработки персональных данных
        </button>
        <button className="btn-primary inline" type="button" onClick={acceptConsent}>
          Согласен
        </button>
      </div>
    );
  }

  if (session.status === "no-telegram") {
    return (
      <div className="signin-wrap">
        <h1 className="title">Кабинет мастера</h1>
        <p className="sub">
          Кабинет открывается только в Telegram — через бота кабинета, на
          телефоне или в Telegram Desktop.
        </p>
      </div>
    );
  }

  const failed = session.status === "error";
  return (
    <div className="signin-wrap">
      <h1 className="title">{failed ? "Не удалось войти" : "Вы вышли"}</h1>
      <p className={failed ? "form-error" : "sub"} role={failed ? "alert" : undefined}>
        {failed ? session.error : "Войдите снова, чтобы управлять расписанием и ценами."}
      </p>
      <button className="btn-primary inline" type="button" onClick={signInWithTelegram}>
        {failed ? "Повторить" : "Войти снова"}
      </button>
    </div>
  );
}
