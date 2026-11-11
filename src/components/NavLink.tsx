"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

export function NavLink({ href, icon, children }: { href: string; icon?: IconName; children: React.ReactNode }) {
  const path = usePathname();
  const active = path === href || path.startsWith(href + "/") || (href === "/board" && path.startsWith("/stories/"));
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className="navlink">
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </Link>
  );
}
