import { useState } from "react";
import { useContent } from "../content.js";
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
  const { settings } = useContent();
  const location = settings.location;

  const copyAddress = async () => {
    const ok = await copyText(location.address);
    setCopied(ok);
    if (!ok) window.prompt("Скопируйте адрес вручную:", location.address);
  };

  return (
    <Screen
      crumb="Как меня найти"
      onBack={onBack}
      footer={
        <>
          {location.mapUrl && (
            <PrimaryButton onClick={() => openLink(location.mapUrl)}>
              Открыть на карте
            </PrimaryButton>
          )}
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
          <p className="panel-text lead">{location.address}</p>
        </div>
        {location.landmark && (
          <Section label="Как войти" text={location.landmark} />
        )}
        {location.transport && (
          <Section label="Как добраться" text={location.transport} />
        )}
        {settings.workingHoursText && (
          <Section label="Время работы" text={settings.workingHoursText} />
        )}
      </div>
    </Screen>
  );
}
