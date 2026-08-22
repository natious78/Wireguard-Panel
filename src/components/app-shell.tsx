"use client";

import {
  Activity,
  BookOpenCheck,
  Cable,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Router,
  Settings,
  ShieldCheck,
  Waypoints,
  X,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client-api";
import { ThemeToggle } from "./theme-toggle";

const groups = [
  {
    label: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "WireGuard",
    items: [
      { href: "/peers", label: "Peers", icon: Waypoints },
      { href: "/interfaces", label: "Interfaces", icon: Cable },
      { href: "/pools", label: "IP Pools", icon: Network },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { href: "/routers", label: "Routers", icon: Router },
      { href: "/traffic", label: "Traffic", icon: Activity },
      { href: "/audit", label: "Audit Logs", icon: BookOpenCheck },
    ],
  },
  {
    label: "System",
    items: [{ href: "/settings", label: "Settings", icon: Settings }],
  },
];

const allItems = groups.flatMap((group) => group.items);

export function AppShell({ user, children }: { user: { username: string; role: string }; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const current = allItems.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <div className="app-shell" data-menu-open={menu}>
      <button className="mobile-overlay" aria-label="Close navigation" onClick={() => setMenu(false)} />
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Waypoints size={22} /></span><div><strong>WG Control</strong><span>Router operations</span></div></div>
        <nav className="nav" aria-label="Primary navigation">
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return <a key={item.href} href={item.href} aria-current={active ? "page" : undefined} onClick={() => setMenu(false)}><Icon aria-hidden="true" />{item.label}</a>;
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-user"><strong>{user.username}</strong><span>{user.role}</span></div>
          <div className="sidebar-actions">
            <ThemeToggle />
            <button className="sidebar-action" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); router.replace("/login"); router.refresh(); }}><LogOut size={17} /><span>Logout</span></button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="button icon-button mobile-menu" aria-label={menu ? "Close navigation" : "Open navigation"} aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X size={19} /> : <Menu size={19} />}</button>
          <div className="topbar-context"><span className="topbar-eyebrow">Control plane</span><strong>{current?.label || "WireGuard Control"}</strong></div>
          <div className="topbar-spacer" />
          <span className="topbar-security"><ShieldCheck aria-hidden="true" />Self-hosted</span>
          <a className="button button-small" href="/health" target="_blank" rel="noreferrer"><Gauge size={15} />System health</a>
        </header>
        <main id="main-content" className="page">{children}</main>
      </div>
    </div>
  );
}
