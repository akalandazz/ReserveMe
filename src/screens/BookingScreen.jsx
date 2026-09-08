import { useCallback, useEffect, useMemo, useState } from "react";
import { refreshBusy, useContent } from "../content.js";
import {
  buildDays,
  buildSlots,
  busyFor,
  dayLabel,
  findDay,
  serverBusyFor,
  toMinutes,
} from "../schedule.js";
import { addBooking, loadBookings, newClientToken } from "../storage.js";
import { submitBooking } from "../supabase.js";
import { bookingMessage, copyText, haptic, sendToMaster, tgUser } from "../telegram.js";
import {
  Icon,
  OptionRow,
  PrimaryButton,
  Screen,
  Steps,
  TextButton,
  Title,
} from "../ui.jsx";

const CRUMB = "Запись";

const SAVED_TOAST =
  "Заявка сохранена. Откройте Telegram, чтобы отправить сообщение.";

export default function BookingScreen({
  step,
  draft,
  setDraft,
  push,
  back,
  home,
}) {
  const [bookings, setBookings] = useState([]);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const { settings, services, activeServices, daysOff, busy } = useContent();

  // Все хуки вызываются безусловно — ветвление только в return,
  // иначе сработает react/rules-of-hooks.
  useEffect(() => {
    let cancelled = false;
    loadBookings().then((list) => {
      if (!cancelled) setBookings(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Занятость перечитываем на входе в каждый шаг, где она видна: пока
  // клиент шёл по флоу, мастер могла закрыть окошко в кабинете или
  // принять чужую заявку на то же время.
  useEffect(() => {
    if (step !== "book:service") refreshBusy();
  }, [step]);

  // Живая версия услуги: мастер мог поменять цену, пока клиент шёл по шагам.
  // Фолбэк на draft.service — если услугу удалили, флоу всё равно завершается.
  const service = useMemo(
    () => services.find((s) => s.id === draft.service?.id) ?? draft.service,
    [services, draft.service]
  );

  const days = useMemo(
    () => buildDays(settings, daysOff),
    [settings, daysOff]
  );
  const day = findDay(days, draft.dateKey);

  // Занято = свои записи (CloudStorage, живут только на этом устройстве)
  // ПЛЮС занятость с сервера: чужие заявки и окошки, закрытые мастером
  // в кабинете. Пересечение своей же записи с её серверной копией
  // безвредно — перекрытие ищется через some().
  const busyOn = useCallback(
    (key) => [
      ...busyFor(bookings, key, settings),
      ...serverBusyFor(busy, key, settings),
    ],
    [bookings, busy, settings]
  );

  const slots = useMemo(
    () => (day && service ? buildSlots(day, service, busyOn(day.key), settings) : []),
    [day, service, busyOn, settings]
  );

  const message = useMemo(() => {
    if (!service || !day || !draft.time) return "";
    return bookingMessage({
      serviceName: service.name,
      dateLabel: dayLabel(day),
      time: draft.time,
      duration: service.duration,
      price: service.price,
      comment: draft.comment.trim(),
    });
  }, [service, day, draft.time, draft.comment]);

  const pickService = (s) => {
    haptic("select");
    // время обнуляем: слот, валидный для 90 мин, может не существовать для 120
    setDraft((d) => ({ ...d, service: s, time: null }));
    push("book:date");
  };

  const pickDay = (d) => {
    haptic("select");
    setDraft((prev) => ({ ...prev, dateKey: d.key, time: null }));
    push("book:time");
  };

  const pickTime = (time) => {
    haptic("select");
    setDraft((d) => ({ ...d, time }));
    push("book:confirm");
  };

  const copy = async () => {
    const ok = await copyText(message);
    setCopied(ok);
    if (!ok) window.prompt("Скопируйте текст вручную:", message);
  };

  const submit = async () => {
    // day может исчезнуть, если клиент завис на подтверждении до полуночи
    // и выбранная дата вышла из окна записи.
    if (sending || !service || !day || !draft.time) return;
    setSending(true);
    haptic("success");

    // Секрет, по которому «Мои записи» потом спросят у сервера, не
    // подтвердила ли мастер эту заявку. Кладём его и в локальную запись,
    // и в серверную строку — связать их иначе нечем: id серверной строки
    // клиенту не возвращается (select по bookings анониму закрыт).
    const token = newClientToken();

    const record = {
      id: String(Date.now()),
      s: service.id,
      d: day.key,
      t: draft.time,
      m: service.duration,
      p: service.price,
      c: draft.comment.trim(),
      k: token,
      st: "new",
    };

    // Сохраняем ДО отправки: openTelegramLink закрывает мини-апп
    await addBooking(record);

    // Серверная копия для кабинета мастера (admin.html) — у него нет
    // доступа к CloudStorage клиента. Best-effort: провал не отменяет
    // запись и не должен задержать отправку сообщения мастеру.
    const u = tgUser();
    await submitBooking({
      day: day.key,
      start_min: toMinutes(draft.time),
      duration: service.duration,
      price: service.price,
      service_id: service.id,
      service_name: service.name,
      client_name: u ? [u.first_name, u.last_name].filter(Boolean).join(" ") : "",
      client_username: u?.username ?? "",
      comment: record.c,
      client_token: token,
    });

    const text = message;
    home(SAVED_TOAST);
    sendToMaster(text);
  };

  if (step === "book:service") {
    return (
      <Screen crumb={CRUMB} onBack={back}>
        <Steps total={3} current={1} />
        <p className="eyebrow step">Шаг 1 из 3</p>
        <Title>Выберите услугу</Title>
        <div className="stack spaced">
          {activeServices.map((s) => (
            <OptionRow
              key={s.id}
              title={s.name}
              meta={[s.note, `${s.duration} мин`].filter(Boolean).join(" · ")}
              price={`${s.price} ₾`}
              selected={draft.service?.id === s.id}
              onClick={() => pickService(s)}
            />
          ))}
        </div>
        {activeServices.length === 0 && (
          <div className="blank tall">Услуги пока не добавлены</div>
        )}
      </Screen>
    );
  }

  if (step === "book:date") {
    return (
      <Screen crumb={CRUMB} onBack={back}>
        <Steps total={3} current={2} />
        <p className="eyebrow step">Шаг 2 из 3</p>
        <Title>Выберите день</Title>
        <p className="sub">{service?.name ?? ""}</p>
        <div className="divided">
          {days.map((d) => {
            const free = d.isOpen
              ? buildSlots(d, service, busyOn(d.key), settings).length
              : 0;
            const disabled = !d.isOpen || free === 0;
            return (
              <button
                key={d.key}
                className="day-row"
                type="button"
                disabled={disabled}
                onClick={() => pickDay(d)}
              >
                <span className="day-num">
                  <span className="dow">{d.weekdayShort}</span>
                  <span className="num">{d.dayMonth.split(" ")[0]}</span>
                </span>
                <span className="list-main">
                  <span className="day-label">{dayLabel(d)}</span>
                  <span className="day-meta">
                    {!d.isOpen
                      ? "выходной"
                      : free === 0
                        ? "нет свободного времени"
                        : `свободно окошек: ${free}`}
                  </span>
                </span>
                <Icon name="chevron" size={15} className="nav-chevron" />
              </button>
            );
          })}
        </div>
      </Screen>
    );
  }

  if (step === "book:time") {
    return (
      <Screen crumb={CRUMB} onBack={back}>
        <Steps total={3} current={3} />
        <p className="eyebrow step">Шаг 3 из 3</p>
        <Title>Выберите время</Title>
        <p className="sub">
          {dayLabel(day)} · {service?.name ?? ""}
        </p>

        {slots.length === 0 ? (
          <div className="blank">
            <p>На этот день свободного времени нет</p>
            <TextButton onClick={back}>Выбрать другой день</TextButton>
            <TextButton
              onClick={() => {
                home();
                push("waitlist");
              }}
            >
              Записаться в лист ожидания
            </TextButton>
          </div>
        ) : (
          <div className="slots">
            {slots.map((t) => (
              <button
                key={t}
                className="slot"
                type="button"
                onClick={() => pickTime(t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </Screen>
    );
  }

  // book:confirm
  const gone = draft.service && !services.some((s) => s.id === draft.service.id);
  // Дата вышла из окна записи, пока клиент был на этом экране (полночь).
  const expired = Boolean(draft.dateKey) && !day;
  // Время разобрали, пока клиент дописывал комментарий. Не блокируем
  // отправку — мастер всё равно подтверждает заявку вручную, — но
  // предупреждаем и предлагаем вернуться к сетке.
  const taken = !expired && Boolean(draft.time) && !slots.includes(draft.time);

  return (
    <Screen
      crumb={CRUMB}
      onBack={back}
      footer={
        <>
          <PrimaryButton onClick={submit} disabled={sending || expired}>
            {sending ? "Отправляем…" : "Отправить заявку"}
          </PrimaryButton>
          <TextButton onClick={copy}>
            {copied ? "Текст скопирован" : "Скопировать текст"}
          </TextButton>
        </>
      }
    >
      <Title>Подтвердите заявку</Title>

      {gone && (
        <p className="notice">
          Эта услуга больше не в прайсе. Заявку отправить можно, но цену лучше
          уточнить в чате.
        </p>
      )}

      {expired && (
        <>
          <p className="notice">
            Эта дата больше не доступна для записи. Выберите, пожалуйста, другой
            день.
          </p>
          <TextButton onClick={() => home()}>Начать заново</TextButton>
        </>
      )}

      {taken && (
        <>
          <p className="notice">
            Это время только что стало занято. Заявку отправить можно, но лучше
            выбрать другое окошко.
          </p>
          <TextButton onClick={back}>Выбрать другое время</TextButton>
        </>
      )}

      <dl className="summary">
        <div className="summary-row">
          <dt>Услуга</dt>
          <dd>{service?.name}</dd>
        </div>
        <div className="summary-row">
          <dt>Дата</dt>
          <dd>{dayLabel(day)}</dd>
        </div>
        <div className="summary-row">
          <dt>Время</dt>
          <dd>{draft.time}</dd>
        </div>
        <div className="summary-row">
          <dt>Длительность</dt>
          <dd>{service?.duration} мин</dd>
        </div>
        <div className="summary-row">
          <dt>Стоимость</dt>
          <dd>{service?.price} ₾</dd>
        </div>
      </dl>

      <label className="eyebrow" htmlFor="booking-comment">
        Комментарий (необязательно)
      </label>
      <textarea
        id="booking-comment"
        className="field"
        rows={3}
        placeholder="Например: аллергия на… / приду с подругой"
        value={draft.comment}
        onChange={(e) => setDraft((d) => ({ ...d, comment: e.target.value }))}
      />

      <p className="notice">
        Запись подтверждается только после ответа {settings.masterName} в
        Telegram.
      </p>

      <p className="eyebrow">Текст сообщения</p>
      <pre className="msg-preview">{message}</pre>
      <p className="note">
        Если текст не подставился в чат автоматически — нажмите «Скопировать
        текст» и вставьте его вручную.
      </p>
    </Screen>
  );
}
