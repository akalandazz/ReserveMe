import { useCallback, useMemo, useState } from "react";
import {
  contentSnapshot,
  refreshAll,
  useContent,
} from "../content.js";
import { createBooking, rescheduleMyBooking } from "../bookings.js";
import {
  buildDays,
  buildSlots,
  dayLabel,
  findDay,
  labelForKey,
  serverBusyFor,
  toMinutes,
} from "../schedule.js";
import {
  bookingMessage,
  copyText,
  haptic,
  rescheduleMessage,
  sendToMaster,
} from "../telegram.js";
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
const MOVED_TOAST =
  "Запрос на перенос сохранён — мастер подтвердит новое время.";

/**
 * Занятость без самой переносимой записи: её окно в busy_slots есть
 * (вьюха не знает, чья строка), и без этого сдвинуть запись на полчаса
 * в пределах её же окна было бы нельзя. Убираем ровно одно совпадение.
 */
function withoutOwn(busy, was) {
  if (!was) return busy;
  const start = toMinutes(was.time);
  const i = busy.findIndex(
    (b) => b.day === was.day && b.start === start && b.duration === was.duration
  );
  return i < 0 ? busy : [...busy.slice(0, i), ...busy.slice(i + 1)];
}

// Сколько ждать сверки с базой перед отправкой. Дольше — клиент ждёт
// кнопку; не дождались — сохраняем как есть (сверку сеть не блокирует,
// а саму заявку — да: без строки в базе её нет, см. submit()).
const FRESH_CHECK_MS = 2_000;

/** Резолвится null, если promise не успел за ms. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export default function BookingScreen({
  step,
  draft,
  setDraft,
  push,
  back,
  home,
}) {
  const [sending, setSending] = useState(false);
  // Заявка не сохранилась на сервере — текст ошибки, кнопка «Повторить».
  const [saveError, setSaveError] = useState("");
  const [copied, setCopied] = useState(false);
  // Сверка перед отправкой нашла, что данные на экране устарели.
  const [outdated, setOutdated] = useState(false);
  const { settings, services, activeServices, daysOff, busy: allBusy } = useContent();
  // Перенос своей записи («Перенести» в «Мои записи»): { id, day, time,
  // duration } — какая запись и где она сейчас. null — новая заявка.
  const moving = draft.reschedule ?? null;
  const busy = useMemo(() => withoutOwn(allBusy, moving), [allBusy, moving]);

  // Все хуки вызываются безусловно — ветвление только в return,
  // иначе сработает react/rules-of-hooks.

  // Контент и занятость перечитывает App.jsx — на входе в каждый шаг (шаг —
  // это экран) и опросом, пока клиент на нём задержался: мастер могла
  // закрыть окошко в кабинете или принять чужую заявку на то же время.

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

  // Занято = занятость с сервера (busy_slots): заявки и записи — в том
  // числе свои же, — и окошки, закрытые мастером в кабинете.
  const busyOn = useCallback(
    (key) => serverBusyFor(busy, key, settings),
    [busy, settings]
  );

  const slots = useMemo(
    () => (day && service ? buildSlots(day, service, busyOn(day.key), settings) : []),
    [day, service, busyOn, settings]
  );

  const message = useMemo(() => {
    if (!service || !day || !draft.time) return "";
    if (moving) {
      return rescheduleMessage({
        serviceName: service.name,
        wasLabel: labelForKey(moving.day),
        wasTime: moving.time,
        dateLabel: dayLabel(day),
        time: draft.time,
      });
    }
    return bookingMessage({
      serviceName: service.name,
      dateLabel: dayLabel(day),
      time: draft.time,
      duration: service.duration,
      price: service.price,
      comment: draft.comment.trim(),
    });
  }, [service, day, draft.time, draft.comment, moving]);

  // Предупреждения шага подтверждения. Считаются здесь, а не в его
  // ветке рендера: submit() сравнивает с ними свежий ответ базы.
  const gone = Boolean(draft.service) && !services.some((s) => s.id === draft.service.id);
  // Дата вышла из окна записи, пока клиент был на этом экране (полночь).
  const expired = Boolean(draft.dateKey) && !day;
  // Время разобрали, пока клиент дописывал комментарий. Не блокируем
  // отправку — мастер всё равно подтверждает заявку вручную, — но
  // предупреждаем и предлагаем вернуться к сетке.
  const taken = !expired && Boolean(draft.time) && !slots.includes(draft.time);

  /**
   * Сверка с только что перечитанной базой: не разошлось ли то, что клиент
   * видит на экране (и что уйдёт в сообщении), с тем, что там сейчас.
   * Уже показанное предупреждение (gone, taken) расхождением не считается —
   * клиент его видел и решил отправить.
   */
  const differsFromServer = (fresh) => {
    const snap = contentSnapshot();
    const now = snap.services.find((s) => s.id === draft.service?.id);

    if (fresh.content) {
      if (!now && !gone) return true;
      if (now && (now.price !== service.price || now.duration !== service.duration)) {
        return true;
      }
    }

    const freshDay = findDay(buildDays(snap.settings, snap.daysOff), draft.dateKey);
    if (!freshDay) return true;
    const freshSlots = buildSlots(
      freshDay,
      now ?? service,
      serverBusyFor(withoutOwn(snap.busy, moving), freshDay.key, snap.settings),
      snap.settings
    );
    return !taken && !freshSlots.includes(draft.time);
  };

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
    setOutdated(false);
    setSaveError("");

    // Последняя сверка с базой — ДО сохранения и до openTelegramLink.
    // Мастер могла поменять цену, закрыть день или окошко, пока клиент
    // дописывал комментарий: тогда не отправляем, а показываем свежие
    // данные (экран перерисуется из стора) и просим проверить ещё раз.
    // База не ответила вовремя — отправляем как есть.
    const fresh = await withTimeout(refreshAll(), FRESH_CHECK_MS);
    if (fresh && (fresh.content || fresh.busy) && differsFromServer(fresh)) {
      haptic("warning");
      setOutdated(true);
      setSending(false);
      return;
    }

    // Сохраняем на сервере ДО отправки: openTelegramLink закрывает
    // мини-апп. Строка в bookings — единственная запись о заявке: её видит
    // мастер в кабинете и сам клиент в «Мои записи». Не сохранилась —
    // сообщение не уходит, клиент видит ошибку и повторяет. Перенос — то
    // же самое: сначала сервер, потом сообщение.
    const res = moving
      ? await rescheduleMyBooking({ id: moving.id, day: day.key, time: draft.time })
      : await createBooking({
          service,
          day: day.key,
          time: draft.time,
          comment: draft.comment.trim(),
        });
    if (!res.ok) {
      haptic("error");
      setSaveError(res.error);
      setSending(false);
      return;
    }

    haptic("success");
    const text = message;
    home(moving ? MOVED_TOAST : SAVED_TOAST);
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

  // Перенос начинается сразу с дня: услуга остаётся та же.
  const total = moving ? 2 : 3;
  const shift = moving ? 1 : 0;
  const crumb = moving ? "Перенос записи" : CRUMB;

  if (step === "book:date") {
    return (
      <Screen crumb={crumb} onBack={back}>
        <Steps total={total} current={2 - shift} />
        <p className="eyebrow step">Шаг {2 - shift} из {total}</p>
        <Title>{moving ? "Новый день" : "Выберите день"}</Title>
        <p className="sub">
          {service?.name ?? ""}
          {moving && ` · сейчас: ${labelForKey(moving.day)}, ${moving.time}`}
        </p>
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
      <Screen crumb={crumb} onBack={back}>
        <Steps total={total} current={3 - shift} />
        <p className="eyebrow step">Шаг {3 - shift} из {total}</p>
        <Title>{moving ? "Новое время" : "Выберите время"}</Title>
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
  return (
    <Screen
      crumb={crumb}
      onBack={back}
      footer={
        <>
          <PrimaryButton onClick={submit} disabled={sending || expired}>
            {sending
              ? "Отправляем…"
              : saveError
                ? "Повторить"
                : moving
                  ? "Перенести запись"
                  : "Отправить заявку"}
          </PrimaryButton>
          <TextButton onClick={copy}>
            {copied ? "Текст скопирован" : "Скопировать текст"}
          </TextButton>
        </>
      }
    >
      <Title>{moving ? "Подтвердите перенос" : "Подтвердите заявку"}</Title>

      {outdated && (
        <p className="notice" role="alert">
          Пока вы оформляли заявку, данные обновились. Проверьте услугу, дату,
          время и цену ниже и отправьте ещё раз.
        </p>
      )}

      {saveError && (
        <p className="notice" role="alert">
          {saveError}
        </p>
      )}

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
        {moving && (
          <div className="summary-row">
            <dt>Было</dt>
            <dd>
              {labelForKey(moving.day)}, {moving.time}
            </dd>
          </div>
        )}
        <div className="summary-row">
          <dt>{moving ? "Станет" : "Дата"}</dt>
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

      {/* Перенос меняет только день и время — комментарий остаётся прежним. */}
      {!moving && (
        <>
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
        </>
      )}

      <p className="notice">
        {moving
          ? `Перенесённая запись снова ждёт подтверждения ${settings.masterName}.`
          : `Запись подтверждается только после ответа ${settings.masterName} в Telegram.`}
      </p>

      <p className="eyebrow">Какие данные мы передаём</p>
      <p className="note">
        Ваши имя и логин из Telegram, выбранные услугу, дату и время,
        стоимость и комментарий (если вы его укажете) — мы отправим{" "}
        {settings.masterName} в Telegram и сохраним в базе заявок, чтобы она
        могла увидеть и подтвердить запись в своём кабинете.
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
