import Link from "next/link";

import { requireOperatorSession } from "@/lib/operator-session-server";

const links = [
  ["/prospects", "Prospects"],
  ["/campaigns", "Campaigns"],
  ["/review", "Review queue"],
  ["/inbox", "Inbox"],
  ["/settings", "Settings"],
] as const;

export const dynamic = "force-dynamic";

export default async function OperatorLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireOperatorSession();
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Link className="brand" href="/">
          Hyperoutreach
        </Link>
        <nav aria-label="Primary navigation">
          {links.map(([href, label]) => (
            <Link href={href} key={href}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="operator-card">
          <span>{session.email}</span>
          <form action="/api/operator/session" method="post">
            <input type="hidden" name="intent" value="logout" />
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <button type="submit" className="button-quiet">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="app-content">{children}</div>
    </div>
  );
}
