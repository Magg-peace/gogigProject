import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  Activity,
  BookOpen,
  BarChart3,
  FileSearch,
  Home,
  LayoutDashboard,
  LogIn,
  LogOut,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

export type UploadStatus = "pending" | "processing" | "completed" | "failed";

const STATUS_STYLES: Record<UploadStatus, string> = {
  pending: "bg-muted text-muted-foreground border-border",
  processing: "bg-info/15 text-info border-info/40 animate-pulse",
  completed: "bg-success/15 text-success border-success/40",
  failed: "bg-destructive/15 text-destructive border-destructive/40",
};

const STATUS_LABELS: Record<UploadStatus, string> = {
  pending: "queued",
  processing: "analysing",
  completed: "completed",
  failed: "exception",
};

export function StatusBadge({ status }: { status: UploadStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest",
        STATUS_STYLES[status],
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** Confidence is always shown as a number — these checks are heuristics, and the
 *  UI must never present a boolean as ground truth. */
export function ConfidenceBar({
  label,
  confidence,
  verdict,
  detail,
  invertColor,
}: {
  label: string;
  confidence: number;
  verdict: string;
  detail?: ReactNode;
  invertColor?: boolean;
}) {
  const pct = Math.round(confidence * 100);
  const tone = invertColor
    ? pct >= 60
      ? "bg-success"
      : pct >= 30
        ? "bg-warning"
        : "bg-destructive"
    : pct >= 60
      ? "bg-destructive"
      : pct >= 30
        ? "bg-warning"
        : "bg-success";
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{pct}% confidence</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{verdict}</p>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full rounded-full transition-all duration-300", tone)} style={{ width: `${pct}%` }} />
      </div>
      {detail ? <div className="mt-3 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "success" | "warning" | "danger" | "info";
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-destructive",
    info: "text-primary",
  }[tone];
  return (
    <div className="rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-3 text-3xl font-semibold tabular-nums", toneClass)}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card p-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-12 text-center">
      <FileSearch className="mx-auto size-8 text-muted-foreground" />
      <p className="mt-4 font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-secondary/70", className)} />;
}

const NAV = [
  { to: "/", label: "Home", icon: Home, exact: true },
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/upload", label: "New Inspection", icon: UploadCloud },
  { to: "/history", label: "Inspections", icon: FileSearch },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/health", label: "System Health", icon: Activity },
  { to: "/api-docs", label: "API Reference", icon: BookOpen },
] as const;

export function Shell({
  children,
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  children: ReactNode;
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen lg:flex">
      <aside className="sticky top-0 z-20 border-b border-sidebar-border bg-sidebar lg:h-screen lg:w-[260px] lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="size-5" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight">FieldSight AI</p>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Media Verification
            </p>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible">
          {NAV.map(({ to, label, icon: Icon, ...rest }) => (
            <Link
              key={to}
              to={to}
              {...("exact" in rest ? { activeOptions: { exact: true } } : {})}
              activeProps={{
                className: "bg-sidebar-accent text-foreground border-l-primary",
              }}
              className="flex shrink-0 items-center gap-2.5 rounded-lg border-l-2 border-l-transparent px-3 py-2.5 text-sm text-muted-foreground transition-all duration-300 hover:bg-sidebar-accent/60 hover:text-foreground"
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="hidden px-5 pb-6 lg:block">
          <div className="rounded-xl border border-border bg-card/60 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Analysis engine
            </p>
            <p className="mt-1 font-mono text-xs">v2.0.0 · 13 checks</p>
          </div>
          <div className="mt-3 rounded-xl border border-border bg-card/60 p-3">
            {loading ? (
              <Skeleton className="h-9" />
            ) : user ? (
              <div className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Signed in
                </p>
                <p className="truncate text-xs">{user.email ?? user.id}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={() => void signOut()}
                >
                  <LogOut className="size-3.5" /> Sign out
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Operator
                </p>
                <p className="text-xs text-muted-foreground">Not signed in</p>
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => void navigate({ to: "/login" })}
                >
                  <LogIn className="size-3.5" /> Sign in with Google
                </Button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {title ? (
          <header className="border-b border-border bg-background/70 px-5 py-6 backdrop-blur md:px-8">
            <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4">
              <div>
                {eyebrow ? (
                  <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-primary">
                    {eyebrow}
                  </p>
                ) : null}
                <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
                {subtitle ? (
                  <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
                ) : null}
              </div>
              {actions}
            </div>
          </header>
        ) : null}
        <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 md:px-8">{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-5 pb-10 text-xs text-muted-foreground md:px-8">
          Built for reliable, explainable and observable AI-assisted vehicle inspection workflows.
          Every result is a heuristic estimate with a confidence score — not a forensic
          determination.
        </footer>
      </div>
    </div>
  );
}

/** Honest realtime indicator: says "live" only when the channel is subscribed. */
export function LiveBadge({ state }: { state: "connecting" | "live" | "offline" }) {
  const styles = {
    connecting: "border-border bg-muted text-muted-foreground",
    live: "border-success/40 bg-success/15 text-success",
    offline: "border-warning/40 bg-warning/15 text-warning",
  }[state];
  const label = { connecting: "connecting", live: "live", offline: "polling" }[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest",
        styles,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full bg-current", state === "live" && "animate-pulse")}
      />
      {label}
    </span>
  );
}
