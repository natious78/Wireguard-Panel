import type { LucideIcon } from "lucide-react";

export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return <header className="page-header"><div><h1 className="page-title">{title}</h1><p className="page-subtitle">{description}</p></div>{actions && <div className="actions">{actions}</div>}</header>;
}

export function Metric({ label, value, foot, icon: Icon }: { label: string; value: React.ReactNode; foot?: React.ReactNode; icon: LucideIcon }) {
  return <div className="metric"><div className="metric-head"><span>{label}</span><span className="metric-icon"><Icon aria-hidden="true" /></span></div><strong className="metric-value">{value}</strong>{foot && <div className="metric-foot">{foot}</div>}</div>;
}

export function StatusBadge({ status, children }: { status: string; children?: React.ReactNode }) {
  return <span className={`status status-${status.replaceAll("_", "-")}`}>{children ?? status.replaceAll("_", " ")}</span>;
}

export function EmptyState({ icon: Icon, title, message, action }: { icon: LucideIcon; title: string; message: string; action?: React.ReactNode }) {
  return <div className="empty"><Icon aria-hidden="true" /><h3>{title}</h3><p>{message}</p>{action}</div>;
}
