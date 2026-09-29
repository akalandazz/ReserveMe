import { useContent } from "../content.js";
import { ListRow, Screen, Title } from "../ui.jsx";

export default function ServicesScreen({ onBack, onPick }) {
  const { activeServices } = useContent();

  return (
    <Screen crumb="Услуги и цены" onBack={onBack}>
      <Title>Услуги и цены</Title>
      <p className="sub">Нажмите на услугу, чтобы записаться</p>

      <div className="divided">
        {activeServices.map((s) => (
          <ListRow
            key={s.id}
            title={s.name}
            meta={[s.note, `${s.duration} мин`].filter(Boolean).join(" · ")}
            price={`${s.price} ₾`}
            onClick={() => onPick(s)}
          />
        ))}
      </div>

      <p className="note">
        Цены указаны в лари (₾). Точную стоимость уточняйте при записи — она
        зависит от состояния ногтей и выбранного дизайна.
      </p>
    </Screen>
  );
}
