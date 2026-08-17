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
 * The only client component in the application. It exists for one thing the
 * server cannot know: which link is the current page.
 */
export function NavLinks({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const isCurrent = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);
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
              aria-current={isCurrent(item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
