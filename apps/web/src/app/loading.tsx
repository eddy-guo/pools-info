export default function Loading() {
  return (
    <div className="page" aria-label="Loading analytics" role="status">
      <div
        className="skeleton"
        style={{ width: 240, height: 35, marginBottom: 30 }}
      />
      <div className="stats-grid">
        {[0, 1, 2, 3].map((i) => (
          <div className="stat" key={i}>
            <div className="skeleton" style={{ height: 75 }} />
          </div>
        ))}
      </div>
      <div className="panel" style={{ padding: 25 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="skeleton"
            style={{ height: 35, marginBottom: 20 }}
          />
        ))}
      </div>
    </div>
  );
}
