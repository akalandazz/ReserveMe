/* ─── Экран запуска кабинета ─────────────────────────────────────
   Полноэкранный слой поверх кабинета, только при запуске: пока
   решается вход и грузятся первые данные. Потом — затухание .35s и
   размонтирование; сохранения и опросы его больше не вызывают, для них
   полоска под шапкой. Тайминг — useBootPhase из src/boot.js (общий);
   клиентская копия экрана — в src/ui.jsx, см. «Two apps» в CLAUDE.md. */

export default function BootScreen({ leaving, error, onRetry }) {
  return (
    <div
      className={leaving ? "boot-screen is-leaving" : "boot-screen"}
      role="status"
      aria-live="polite"
    >
      <img
        className="boot-mascot"
        src="/loading/mascot.webp"
        width="491"
        height="512"
        alt=""
        aria-hidden="true"
        decoding="async"
      />
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
          <p className="boot-label">Загружаем…</p>
        </>
      )}
    </div>
  );
}
