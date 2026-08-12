import Link from "next/link";

export default function DashboardPage() {
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Operator dashboard</p>
          <h1>Campaign state at a glance</h1>
          <p className="muted">
            Research, review, sending, and reply handling all use the persisted
            application path.
          </p>
        </div>
      </header>
      <section className="card-grid" aria-label="Work areas">
        <Link className="metric-card" href="/prospects">
          <strong>Prospects</strong>
          <span>Discover, research, resolve, and inspect evidence.</span>
        </Link>
        <Link className="metric-card" href="/review">
          <strong>Review queue</strong>
          <span>Inspect and approve the exact message that will be sent.</span>
        </Link>
        <Link className="metric-card" href="/inbox">
          <strong>Replies</strong>
          <span>See classifications and the sequence outcome.</span>
        </Link>
      </section>
    </main>
  );
}
