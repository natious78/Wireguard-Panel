"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export function ThemeToggle({ className = "sidebar-action" }: { className?: string }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const saved = localStorage.getItem("wg-theme") as "light" | "dark" | null;
    const initial = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(initial); document.documentElement.dataset.theme = initial;
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next); localStorage.setItem("wg-theme", next); document.documentElement.dataset.theme = next;
  };
  return <button type="button" className={className} onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
    {theme === "dark" ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}<span>Theme</span>
  </button>;
}
