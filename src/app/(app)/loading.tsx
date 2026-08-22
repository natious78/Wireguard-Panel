export default function AppLoading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="sr-only">Loading page</span>
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-subtitle" />
      <div className="skeleton-grid">
        {Array.from({ length: 4 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}
      </div>
      <div className="card skeleton-table">
        <div className="skeleton skeleton-toolbar" />
        {Array.from({ length: 7 }, (_, index) => <div className="skeleton skeleton-row" key={index} />)}
      </div>
    </div>
  );
}
