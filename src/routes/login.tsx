import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, LogIn } from "lucide-react";
import { lovable } from "@/integrations/lovable";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — FieldSight AI operations console" },
      {
        name: "description",
        content:
          "Sign in with your Google workspace account to access the FieldSight AI vehicle inspection console, audit trails and observability dashboards.",
      },
      { property: "og:title", content: "Sign in to FieldSight AI" },
      {
        property: "og:description",
        content: "Google sign-in for the FieldSight AI vehicle media verification console.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session) void navigate({ to: "/dashboard" });
  }, [session, navigate]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: `${window.location.origin}/login`,
      extraParams: { prompt: "select_account" },
    });
    if (result.error) {
      setError(result.error.message ?? "Google sign-in failed. Please try again.");
      setBusy(false);
      return;
    }
    if (result.redirected) return;
    setBusy(false);
  };

  return (
    <main className="grid min-h-screen place-items-center px-5 py-16">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8">
        <div className="flex items-center gap-2.5">
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

        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Sign in to the console</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Inspections are attributable: signing in ties uploads, retries and report exports to a
          named operator in the audit trail.
        </p>

        {error ? (
          <p className="mt-5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Button className="mt-6 w-full" onClick={() => void signIn()} disabled={busy || loading}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
          Continue with Google
        </Button>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Prefer to look around first?{" "}
          <Link to="/dashboard" className="text-primary underline-offset-4 hover:underline">
            Open the dashboard
          </Link>
        </p>
      </div>
    </main>
  );
}
