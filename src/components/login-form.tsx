"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, LogIn } from "lucide-react";
import { api } from "@/lib/client-api";
import { InstallPrompt } from "./pwa";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  return <>
    <form className="form" onSubmit={async (event) => {
      event.preventDefault(); setError(""); setLoading(true);
      const data = new FormData(event.currentTarget);
      try {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: data.get("username"), password: data.get("password") }) });
        router.replace("/dashboard"); router.refresh();
      } catch (input) { setError(input instanceof Error ? input.message : "Sign in failed."); }
      finally { setLoading(false); }
    }}>
      <div className="form-group"><label className="label" htmlFor="username">Username</label><input className="field" id="username" name="username" autoComplete="username" required autoFocus /></div>
      <div className="form-group"><label className="label" htmlFor="password">Password</label><input className="field" id="password" name="password" type="password" autoComplete="current-password" required /></div>
      {error && <div className="form-message form-message-error" role="alert">{error}</div>}
      <button className="button button-primary" disabled={loading}>{loading ? <LoaderCircle className="spin" size={18} /> : <LogIn size={18} />}{loading ? "Signing in…" : "Sign in"}</button>
    </form>
    <InstallPrompt />
  </>;
}
