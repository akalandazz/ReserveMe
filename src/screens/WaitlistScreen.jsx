import { useMemo, useState } from "react";
import { MASTER_NAME, SERVICES, TIME_OF_DAY } from "../data.js";
import { buildDays } from "../schedule.js";
import {
  copyText,
  haptic,
  sendToMaster,
  showAlert,
  waitlistMessage,
} from "../telegram.js";
import {
  Chip,
  OptionRow,
  PrimaryButton,
  Screen,
  TextButton,
  Title,
} from "../ui.jsx";

const SENT_TOAST =
  "Заявка сохранена. Откройте Telegram, чтобы отправить сообщение.";

const toggle = (list, value) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export default function WaitlistScreen({ onBack, home }) {
  const [serviceId, setServiceId] = useState(null);
  const [days, setDays] = useState([]);
  const [parts, setParts] = useState([]);
  const [comment, setComment] = useState("");
  const [copied, setCopied] = useState(false);

  const openDays = useMemo(() => buildDays().filter((d) => d.isOpen), []);
  const service = SERVICES.find((s) => s.id === serviceId) || null;

  const message = useMemo(() => {
    if (!service) return "";
    const chosen = openDays.filter((d) => days.includes(d.key));
    return waitlistMessage({
      serviceName: `${service.name} (${service.price} ₾, ${service.duration} мин)`,
      daysLabel:
        chosen.length > 0
          ? chosen.map((d) => `${d.weekdayShort} ${d.dayMonth}`).join(", ")
          : "любые дни",
      timeLabel:
        parts.length > 0
          ? TIME_OF_DAY.filter((p) => parts.includes(p.id))
              .map((p) => p.label)
              .join(", ")
          : "любое время",
      comment: comment.trim(),
    });
  }, [service, days, parts, comment, openDays]);

  const copy = async () => {
    const ok = await copyText(message);
    setCopied(ok);
    if (!ok) window.prompt("Скопируйте текст вручную:", message);
  };

  const submit = () => {
    if (!service) {
      showAlert("Выберите услугу");
      return;
    }
    haptic("success");
    const text = message;
    home(SENT_TOAST);
    sendToMaster(text);
  };

  return (
    <Screen
      crumb="Лист ожидания"
      onBack={onBack}
      footer={
        <>
          <PrimaryButton onClick={submit} disabled={!service}>
            Отправить заявку
          </PrimaryButton>
          {service && (
            <TextButton onClick={copy}>
              {copied ? "Текст скопирован" : "Скопировать текст"}
            </TextButton>
          )}
        </>
      }
    >
      <Title>Хочу окошко</Title>
      <p className="sub">
        {MASTER_NAME} напишет, когда освободится подходящее время
      </p>

      <p className="eyebrow">Услуга</p>
      <div className="stack">
        {SERVICES.map((s) => (
          <OptionRow
            key={s.id}
            title={s.name}
            meta={`${s.duration} мин`}
            price={`${s.price} ₾`}
            selected={serviceId === s.id}
            onClick={() => {
              haptic("select");
              setServiceId(s.id);
            }}
          />
        ))}
      </div>

      <p className="eyebrow">Удобные дни — можно несколько</p>
      <div className="chips">
        {openDays.map((d) => (
          <Chip
            key={d.key}
            label={`${d.weekdayShort} ${d.dayMonth.split(" ")[0]}`}
            pressed={days.includes(d.key)}
            onClick={() => setDays((prev) => toggle(prev, d.key))}
          />
        ))}
      </div>

      <p className="eyebrow">Удобное время</p>
      <div className="stack tight">
        {TIME_OF_DAY.map((p) => (
          <OptionRow
            key={p.id}
            wide
            title={p.label}
            selected={parts.includes(p.id)}
            onClick={() => setParts((prev) => toggle(prev, p.id))}
          />
        ))}
      </div>

      <label className="eyebrow" htmlFor="waitlist-comment">
        Комментарий
      </label>
      <textarea
        id="waitlist-comment"
        className="field"
        rows={3}
        placeholder="Например: могу приехать за 20 минут"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />

      {service && (
        <>
          <p className="eyebrow">Текст сообщения</p>
          <pre className="msg-preview">{message}</pre>
          <p className="note">
            Если текст не подставился в чат автоматически — нажмите
            «Скопировать текст» и вставьте его вручную.
          </p>
        </>
      )}
    </Screen>
  );
}
