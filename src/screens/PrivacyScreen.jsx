import { Fragment } from "react";
import { operatorRows, policySections, POLICY_DATE } from "../legal.js";
import { Screen, Title } from "../ui.jsx";

/** Абзац или список из legal.js. */
function Block({ item }) {
  if (typeof item === "string") return <p>{item}</p>;
  return (
    <ul>
      {item.list.map((li) => (
        <li key={li}>{li}</li>
      ))}
    </ul>
  );
}

/**
 * Текст политики обработки ПДн — без каркаса экрана: его же рисуют экран
 * согласия (до входа) и отдельная страница privacy.html.
 */
export function PolicyText() {
  return (
    <div className="legal">
      {policySections().map((s) => (
        <section key={s.title}>
          <h2>{s.title}</h2>
          {s.body.map((item, i) => (
            <Block key={i} item={item} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** «Об исполнителе» (Закон о защите прав потребителей, ст. 9). */
export function OperatorDetails() {
  return (
    <div className="legal">
      <dl>
        {operatorRows().map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

export default function PrivacyScreen({ onBack }) {
  return (
    <Screen crumb="Персональные данные" onBack={onBack}>
      <Title>Политика обработки персональных данных</Title>
      <p className="sub">Редакция от {POLICY_DATE}</p>
      <PolicyText />
    </Screen>
  );
}
