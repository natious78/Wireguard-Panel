import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession(); if (!user) redirect("/login");
  return <AppShell user={user}>{children}</AppShell>;
}
