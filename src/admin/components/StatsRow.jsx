export default function StatsRow({ pendingCount, todayCount, weekCount }) {
  const tiles = [
    { v: pendingCount, k: "Заявки" },
    { v: todayCount, k: "Сегодня" },
    { v: weekCount, k: "На неделе" },
  ];
  return (
    <div className="stats-grid">
      {tiles.map((t) => (
        <div className="stat-tile" key={t.k}>
          <span className="stat-value">{t.v}</span>
          <span className="stat-label">{t.k}</span>
        </div>
      ))}
    </div>
  );
}
