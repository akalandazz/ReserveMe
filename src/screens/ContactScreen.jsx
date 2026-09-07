import { useState } from "react";
import { MASTER_NAME, MASTER_PHONE } from "../data.js";
import {
  MASTER_NOT_SET,
  copyText,
  greetingMessage,
  sendToMaster,
} from "../telegram.js";
import { PillButton, PrimaryButton, Screen, Title } from "../ui.jsx";

export default function ContactScreen({ onBack }) {
  const [copied, setCopied] = useState(false);

  const copyPhone = async () => {
    const ok = await copyText(MASTER_PHONE);
    setCopied(ok);
    if (!ok) window.prompt("Скопируйте номер вручную:", MASTER_PHONE);
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
      <Title>Написать {MASTER_NAME}</Title>
      <p className="sub">Отвечаю обычно в течение дня</p>

      <div className="panel">
        <div className="panel-section">
          <p className="panel-text lead">Вопросы, переносы, отмены</p>
          <p className="panel-text">
            Пишите напрямую — {MASTER_NAME} ответит в личных сообщениях. Заявки
            из приложения тоже приходят сюда.
          </p>
        </div>
      </div>

      {MASTER_PHONE && (
        <div className="panel phone">
          <div className="panel-section row">
            <span className="list-main">
              <span className="kicker">Телефон</span>
              <span className="phone-value">{MASTER_PHONE}</span>
            </span>
            <PillButton onClick={copyPhone}>
              {copied ? "Скопировано" : "Скопировать"}
            </PillButton>
          </div>
        </div>
      )}

      {MASTER_NOT_SET && (
        <p className="notice">
          В файле <code>src/data.js</code> не указан настоящий{" "}
          <code>MASTER_USERNAME</code> — кнопка не откроет чат.
        </p>
      )}
    </Screen>
  );
}
