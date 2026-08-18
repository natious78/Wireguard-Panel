"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Activity, BookOpenCheck, Cable, Gauge, LayoutDashboard, LogOut, Menu, Network, Router, Settings, ShieldCheck, Waypoints, X } from "lucide-react";
import { api } from "@/lib/client-api";
import { ThemeToggle } from "./theme-toggle";

const items = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/routers", label: "Routers", icon: Router },
  { href: "/peers", label: "WireGuard Peers", icon: Waypoints },
  { href: "/interfaces", label: "Interfaces", icon: Cable },
  { href: "/pools", label: "WireGuard Pools", icon: Network },
  { href: "/traffic", label: "Traffic", icon: Activity },
  { href: "/audit", label: "Audit Logs", icon: BookOpenCheck },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ user, children }: { user: { username: string; role: string }; children: React.ReactNode }) {
  const pathname = usePathname(); const router = useRouter(); const [menu, setMenu] = useState(false);
  return <div className="app-shell" data-menu-open={menu}>
    <button className="mobile-overlay" aria-label="Close menu" onClick={() => setMenu(false)} />
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Waypoints size={22} /></span><div><strong>WG Control</strong><span>Router operations</span></div></div>
      <div className="nav-label">Operations</div>
      <nav className="nav" aria-label="Primary navigation">{items.map((item) => { const Icon=item.icon; const active=pathname===item.href || pathname.startsWith(`${item.href}/`); return <a key={item.href} href={item.href} aria-current={active ? "page" : undefined} onClick={() => setMenu(false)}><Icon aria-hidden="true" />{item.label}</a>; })}</nav>
      <div className="sidebar-footer"><div className="sidebar-user"><strong>{user.username}</strong>{user.role}</div><div className="sidebar-actions">
        <ThemeToggle />
        <button className="sidebar-action" onClick={async () => { await api("/api/auth/logout", { method:"POST" }); router.replace("/login"); router.refresh(); }}><LogOut size={17} /><span>Logout</span></button>
      </div></div>
    </aside>
    <div className="main">
      <header className="topbar"><button className="button icon-button mobile-menu" aria-label={menu?"Close menu":"Open menu"} onClick={() => setMenu(!menu)}>{menu?<X size={19}/>:<Menu size={19}/>}</button><div className="topbar-context"><ShieldCheck aria-hidden="true" /><span>Secure self-hosted control plane</span></div><div className="topbar-spacer" /><a className="button button-small" href="/health" target="_blank"><Gauge size={15} />System health</a></header>
      <main id="main-content" className="page">{children}</main>
    </div>
  </div>;
}
