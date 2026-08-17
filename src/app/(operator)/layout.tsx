import Link from "next/link";

import { requireOperatorSession } from "@/lib/operator-session-server";
import { NavLinks, type NavGroup } from "./nav-links";

export const dynamic = "force-dynamic";

// No live counts here on purpose: layouts do not rerender on client-side
// navigation, so a number rendered in this file freezes while the operator
// moves between pages. The pages themselves carry the authoritative numbers.
const groups: NavGroup[] = [
  { label: null, items: [{ href: "/", label: "Overview" }] },
  {
    label: "Pipeline",
    items: [
      { href: "/prospects", label: "Prospects" },
      { href: "/campaigns", label: "Campaigns" },
      { href: "/review", label: "Review queue" },
    ],
  },
  {
    label: "Activity",
    items: [
      { href: "/outbound", label: "What goes out" },
      { href: "/inbox", label: "Inbox" },
    ],
  },
  {
    label: "Setup",
    items: [{ href: "/settings", label: "Settings" }],
  },
];

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
        <NavLinks groups={groups} />
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
