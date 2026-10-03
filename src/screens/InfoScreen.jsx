import { useContent } from "../content.js";
import { Eyebrow, OutlineButton, Screen, TextButton, Title } from "../ui.jsx";
import { OperatorDetails } from "./PrivacyScreen.jsx";

export default function InfoScreen({ onBack, onContact, onPrivacy }) {
  const { settings, infoBlocks } = useContent();

  return (
    <Screen crumb="Информация" onBack={onBack}>
      <Title>Важная информация</Title>

      <div className="divided">
        {infoBlocks.map((block) => (
          <div key={block.id} className="info-row">
            <p>{block.title}</p>
            <p>{block.body}</p>
          </div>
        ))}
      </div>

      <OutlineButton onClick={onContact}>
        Написать {settings.masterName}
      </OutlineButton>
      <p className="note center">Остались вопросы? Напишите мне</p>

      {/* Не блок «Важной информации» в базе: те же данные, что в политике
          и согласии (src/legal.js), — мастер не сотрёт их случайно. */}
      <Eyebrow>Об исполнителе</Eyebrow>
      <OperatorDetails />
      <TextButton onClick={onPrivacy}>Политика обработки персональных данных</TextButton>
    </Screen>
  );
}
