import { useState } from "react";
import { LOCATION, WORKING_HOURS_TEXT } from "../data.js";
import { copyText, openLink } from "../telegram.js";
import { PrimaryButton, Screen, TextButton, Title } from "../ui.jsx";

function Section({ label, text }) {
  return (
    <div className="panel-section">
      <p className="kicker">{label}</p>
      <p className="panel-text">{text}</p>
    </div>
  );
}

export default function LocationScreen({ onBack }) {
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    const ok = await copyText(LOCATION.address);
    setCopied(ok);
    if (!ok) window.prompt("Скопируйте адрес вручную:", LOCATION.address);
  };

  return (
    <Screen
      crumb="Как меня найти"
      onBack={onBack}
      footer={
        <>
          <PrimaryButton onClick={() => openLink(LOCATION.mapUrl)}>
            Открыть на карте
          </PrimaryButton>
          <TextButton onClick={copyAddress}>
            {copied ? "Адрес скопирован" : "Скопировать адрес"}
          </TextButton>
        </>
      }
    >
      <Title>Как меня найти</Title>

      <div className="panel">
        <div className="panel-section">
          <p className="kicker">Адрес</p>
          <p className="panel-text lead">{LOCATION.address}</p>
        </div>
        {LOCATION.landmark && (
          <Section label="Как войти" text={LOCATION.landmark} />
        )}
        {LOCATION.transport && (
          <Section label="Как добраться" text={LOCATION.transport} />
        )}
        <Section label="Время работы" text={WORKING_HOURS_TEXT} />
      </div>
    </Screen>
  );
}
