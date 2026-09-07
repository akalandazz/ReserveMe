import { useContent } from "../content.js";
import { OutlineButton, Screen, Title } from "../ui.jsx";

export default function InfoScreen({ onBack, onContact }) {
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
    </Screen>
  );
}
