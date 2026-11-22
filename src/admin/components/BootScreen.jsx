/* ─── Экран запуска кабинета ─────────────────────────────────────
   Полноэкранный слой поверх кабинета, только при запуске: пока
   решается вход и грузятся первые данные. Потом — затухание .35s и
   размонтирование; сохранения и опросы его больше не вызывают, для них
   полоска под шапкой. Тайминг — useBootPhase из src/boot.js (общий);
   клиентская копия экрана — в src/ui.jsx, см. «Two apps» в CLAUDE.md.

   Раскладка: маскот один в оптическом центре, статус (или ошибка с
   «Повторить») — внизу, под большим пальцем. */

import { useBootSlow } from "../../boot.js";

export default function BootScreen({ leaving, error, onRetry }) {
  const slow = useBootSlow(!error);
  const cls = ["boot-screen", leaving && "is-leaving", error && "is-error"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} role="status" aria-live="polite">
      <div className="boot-stage">
        <div className="boot-figure">
          <img
            className="boot-mascot"
            src="/loading/mascot.webp"
            width="860"
            height="890"
            alt=""
            aria-hidden="true"
            decoding="async"
          />
          <div className="boot-floor" aria-hidden="true" />
        </div>
      </div>
      <div className="boot-foot">
        <p className="boot-title">Кабинет мастера</p>
        {error ? (
          <>
            <p className="boot-error">Не удалось загрузить данные</p>
            <p className="boot-detail">{error}</p>
            <button className="btn-primary inline boot-retry" type="button" onClick={onRetry}>
              Повторить
            </button>
          </>
        ) : (
          <>
            <div className="boot-line" aria-hidden="true">
              <div className="progress-fill" />
            </div>
            <p className="boot-label">
              {slow ? "Загрузка занимает дольше обычного…" : "Загружаем…"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
