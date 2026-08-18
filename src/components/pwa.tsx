"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export function PwaRuntime() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") navigator.serviceWorker.register("/sw.js");
  }, []);
  return null;
}

export function InstallPrompt() {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const handler = (input: Event) => { input.preventDefault(); setEvent(input as InstallEvent); };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  if (!event || hidden) return null;
  return <div className="install-banner">
    <Download size={18} aria-hidden="true" />
    <p>Install WireGuard Control for a standalone app experience.</p>
    <button className="button button-small button-primary" onClick={async () => { await event.prompt(); if ((await event.userChoice).outcome === "accepted") setHidden(true); }}>Install</button>
    <button className="button button-ghost icon-button button-small" aria-label="Dismiss install prompt" onClick={() => setHidden(true)}><X size={16} /></button>
  </div>;
}
