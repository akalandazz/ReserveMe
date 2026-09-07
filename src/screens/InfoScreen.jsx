import { INFO_BLOCKS, MASTER_NAME } from "../data.js";
import { OutlineButton, Screen, Title } from "../ui.jsx";

export default function InfoScreen({ onBack, onContact }) {
  return (
    <Screen crumb="Информация" onBack={onBack}>
      <Title>Важная информация</Title>

      <div className="divided">
        {INFO_BLOCKS.map((block) => (
          <div key={block.title} className="info-row">
            <p>{block.title}</p>
            <p>{block.text}</p>
          </div>
        ))}
      </div>

      <OutlineButton onClick={onContact}>Написать {MASTER_NAME}</OutlineButton>
      <p className="note center">Остались вопросы? Напишите мне</p>
    </Screen>
  );
}
