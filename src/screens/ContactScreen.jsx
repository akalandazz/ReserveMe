import { useState } from "react";
import { useContent } from "../content.js";
import {
  copyText,
  greetingMessage,
  masterNotSet,
  sendToMaster,
} from "../telegram.js";
import { PillButton, PrimaryButton, Screen, Title } from "../ui.jsx";

export default function ContactScreen({ onBack }) {
  const [copied, setCopied] = useState(false);
  const { settings } = useContent();
  const { masterName, masterPhone } = settings;

  const copyPhone = async () => {
    const ok = await copyText(masterPhone);
    setCopied(ok);
    if (!ok) window.prompt("Скопируйте номер вручную:", masterPhone);
  };

  return (
    <Screen
      crumb="Контакты"
      onBack={onBack}
      footer={
        <PrimaryButton onClick={() => sendToMaster(greetingMessage())}>
          Написать в Telegram
        </PrimaryButton>
      }
    >
      <Title>Написать {masterName}</Title>
      <p className="sub">Отвечаю обычно в течение дня</p>

      <div className="panel">
        <div className="panel-section">
          <p className="panel-text lead">Вопросы, переносы, отмены</p>
          <p className="panel-text">
            Пишите напрямую — {masterName} ответит в личных сообщениях. Заявки
            из приложения тоже приходят сюда.
          </p>
        </div>
      </div>

      {masterPhone && (
        <div className="panel phone">
          <div className="panel-section row">
            <span className="list-main">
              <span className="kicker">Телефон</span>
              <span className="phone-value">{masterPhone}</span>
            </span>
            <PillButton onClick={copyPhone}>
              {copied ? "Скопировано" : "Скопировать"}
            </PillButton>
          </div>
        </div>
      )}

      {masterNotSet() && (
        <p className="notice">
          Не указан Telegram-логин мастера — кнопка не откроет чат. Впишите его
          в «Настройки» → «Контакты и адрес».
        </p>
      )}
    </Screen>
  );
}
