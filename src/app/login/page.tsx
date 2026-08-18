import { redirect } from "next/navigation";
import { ShieldCheck, Waypoints } from "lucide-react";
import { getSession } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";

export const metadata = { title: "Sign in" };
export default async function LoginPage() {
  if (await getSession()) redirect("/dashboard");
  return <main id="main-content" className="login-page">
    <section className="login-brand" aria-label="Product introduction">
      <div className="brand-mark"><Waypoints size={25} /></div>
      <h1>WireGuard operations without the blind spots.</h1>
      <p>Manage peers across MikroTik routers, reconcile out-of-band changes, and keep every sensitive key on infrastructure you control.</p>
      <div className="login-points"><span className="login-point">Self-hosted</span><span className="login-point">Encrypted at rest</span><span className="login-point">Safe reconciliation</span><span className="login-point">RouterOS v7</span></div>
    </section>
    <section className="login-panel"><div className="login-card">
      <ShieldCheck size={30} color="var(--primary)" aria-hidden="true" /><h2>Administrator sign in</h2><p>Use your WireGuard Control account to continue.</p><LoginForm />
    </div></section>
  </main>;
}
