"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = {
  href: string;
  label: string;
};

export type NavGroup = {
  label: string | null;
  items: NavItem[];
};

/**
 * Whether this link is the page being looked at.
 *
 * Matched on a path boundary, never on a bare prefix: `startsWith` alone marks
 * `/review` current on a future `/reviews`, and this drives a visible
 * highlight (`globals.css`, `a[aria-current="page"]`), so the wrong link would
 * look like the page you are on. Root is exact — every path starts with `/`.
 *
 * Exported because it is the whole decision this component makes, and inside
 * the component it was reachable only by rendering a browser.
 */
export function isCurrentPath(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The only client component in the application. It exists for one thing the
 * server cannot know: which link is the current page.
 */
export function NavLinks({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary navigation">
      {groups.map((group, index) => (
        <div key={group.label ?? index} className="nav-group">
          {group.label ? (
            <p className="nav-group-label">{group.label}</p>
          ) : null}
          {group.items.map((item) => (
            <Link
              href={item.href}
              key={item.href}
              aria-current={
                isCurrentPath(item.href, pathname) ? "page" : undefined
              }
            >
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
