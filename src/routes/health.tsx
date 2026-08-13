import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Activity, CheckCircle2, AlertTriangle, RefreshCw, Skull, RotateCcw } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { getHealthFn, getQueueOpsFn, replayFailedJobsFn } from "@/lib/metrics.functions";
import { retryUploadFn } from "@/lib/uploads.functions";
import { Shell, Panel, Skeleton, MetricCard, LiveBadge } from "@/components/vehicle-check";
import { useRealtimeUploads } from "@/hooks/use-realtime-uploads";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/health")({
  head: () => ({
    meta: [
      { title: "System Health — FieldSight AI operations" },
      {
        name: "description",
        content:
          "Live dependency probes for the FieldSight AI pipeline: database, object storage, analysis worker and OCR provider, with latency per component.",
      },
      { property: "og:title", content: "FieldSight AI System Health" },
      {
        property: "og:description",
        content: "Live dependency probes and latency for the vehicle inspection pipeline.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HealthPage,
});

function HealthPage() {
  const getHealth = useServerFn(getHealthFn);
  const getQueueOps = useServerFn(getQueueOpsFn);
  const replayAll = useServerFn(replayFailedJobsFn);
  const retryOne = useServerFn(retryUploadFn);
  const queryClient = useQueryClient();
  const realtime = useRealtimeUploads("queue-ops");
  const [replaying, setReplaying] = useState(false);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["health"],
    queryFn: () => getHealth(),
    refetchInterval: 30_000,
  });
  const { data: ops } = useQuery({
    queryKey: ["queue-ops"],
    queryFn: () => getQueueOps(),
    refetchInterval: 30_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["queue-ops"] });
    void queryClient.invalidateQueries({ queryKey: ["health"] });
  };

  const healthy = data?.status === "healthy";

  return (
    <Shell
      eyebrow="Observability"
      title="System health"
      subtitle="Each dependency is probed independently so a partial outage is visible rather than averaged away."
      actions={
        <div className="flex items-center gap-3">
          <LiveBadge state={realtime} />
          <Button variant="secondary" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn("size-4", isFetching && "animate-spin")} /> Re-probe
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <>
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-6",
              healthy
                ? "border-success/40 bg-success/10"
                : "border-warning/40 bg-warning/10",
            )}
          >
            <div className="flex items-center gap-3">
              {healthy ? (
                <CheckCircle2 className="size-6 text-success" />
              ) : (
                <AlertTriangle className="size-6 text-warning" />
              )}
              <div>
                <p className="text-lg font-semibold">
                  {healthy ? "All systems operational" : "Degraded service"}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  checked {data ? new Date(data.checked_at).toLocaleTimeString() : "—"} · auto-refresh 30s
                </p>
              </div>
            </div>
            <Activity className={cn("size-6", healthy ? "text-success" : "text-warning")} />
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {data?.components.map((c) => (
              <div key={c.name} className="rounded-2xl border border-border bg-card p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">{c.name}</p>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest",
                      c.status === "healthy"
                        ? "border-success/40 bg-success/15 text-success"
                        : "border-warning/40 bg-warning/15 text-warning",
                    )}
                  >
                    <span className="size-1.5 rounded-full bg-current" />
                    {c.status}
                  </span>
                </div>
                <p className="mt-3 font-mono text-2xl tabular-nums">{c.latency_ms} ms</p>
                {c.detail ? (
                  <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                    {c.detail}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">Probe returned successfully.</p>
                )}
              </div>
            ))}
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Dead-letter"
              value={ops?.counts.dead_letter ?? 0}
              hint={`failed ≥ ${ops?.max_attempts ?? 3} attempts`}
              tone={ops?.counts.dead_letter ? "danger" : "success"}
            />
            <MetricCard
              label="Retryable"
              value={ops?.counts.retryable ?? 0}
              hint="failed, budget remaining"
              tone={ops?.counts.retryable ? "warning" : "success"}
            />
            <MetricCard
              label="Total retries"
              value={ops?.counts.total_retries ?? 0}
              hint={`${ops?.counts.retried_jobs ?? 0} jobs re-driven`}
            />
            <MetricCard
              label="Retry success"
              value={`${ops?.counts.retry_success_rate ?? 0}%`}
              hint={`${ops?.counts.recovered_after_retry ?? 0} recovered`}
              tone="info"
            />
          </div>

          <Panel
            className="mt-6"
            title="Dead-letter queue"
            description={`Jobs that exhausted their ${ops?.max_attempts ?? 3} delivery attempts. They are never re-driven automatically — an operator decides.`}
            action={
              <Button
                variant="secondary"
                disabled={replaying || !(ops?.counts.retryable || ops?.counts.stuck)}
                onClick={async () => {
                  setReplaying(true);
                  try {
                    await replayAll({ data: undefined });
                  } finally {
                    setReplaying(false);
                    invalidate();
                  }
                }}
              >
                <RotateCcw className={cn("size-4", replaying && "animate-spin")} /> Replay retryable
              </Button>
            }
          >
            {ops && (ops.dead_letter.length || ops.retryable.length || ops.stuck.length) ? (
              <div className="space-y-3">
                {[
                  ...ops.stuck.map((j) => ({ job: j, kind: "stuck" as const })),
                  ...ops.dead_letter.map((j) => ({ job: j, kind: "dead" as const })),
                  ...ops.retryable.map((j) => ({ job: j, kind: "retryable" as const })),
                ].map(({ job, kind }) => (
                  <div
                    key={job.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card/60 p-4"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {kind === "dead" ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/15 px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-destructive">
                            <Skull className="size-3" /> dead-letter
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/15 px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-warning">
                            {kind === "stuck" ? "stuck worker" : "retryable"}
                          </span>
                        )}
                        <Link
                          to="/uploads/$id"
                          params={{ id: job.id }}
                          className="truncate font-mono text-xs text-primary underline-offset-4 hover:underline"
                        >
                          {job.id.slice(0, 8)}
                        </Link>
                        <span className="truncate text-sm">{job.original_filename}</span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        attempt {job.retry_count ?? 0}/{ops.max_attempts} · last change{" "}
                        {new Date(job.updated_at).toLocaleString()}
                      </p>
                      {job.failure_reason ? (
                        <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2 font-mono text-[11px] text-destructive">
                          {job.failure_reason}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        try {
                          await retryOne({ data: { id: job.id } });
                        } finally {
                          invalidate();
                        }
                      }}
                    >
                      <RotateCcw className="size-3.5" /> Re-drive
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No failed, stuck or dead-lettered jobs. Every inspection either completed or is
                still in flight.
              </p>
            )}

            {ops?.failure_reasons.length ? (
              <div className="mt-5 rounded-xl border border-border bg-card/40 p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  Failure reasons
                </p>
                <ul className="mt-3 space-y-2 text-sm">
                  {ops.failure_reasons.map((r) => (
                    <li key={r.reason} className="flex items-start justify-between gap-3">
                      <span className="font-mono text-xs text-muted-foreground">{r.reason}</span>
                      <span className="tabular-nums">{r.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>

          <Panel
            className="mt-6"
            title="Probe semantics"
            description="What each check actually asserts, so a green light means something specific."
          >
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><span className="text-foreground">Database</span> — a real read against the uploads table, not a TCP ping.</li>
              <li><span className="text-foreground">Object Storage</span> — a bucket listing against the private media bucket.</li>
              <li><span className="text-foreground">Analysis Worker</span> — stuck-job detection: any job claimed for over five minutes means a worker died mid-run.</li>
              <li><span className="text-foreground">OCR Provider</span> — credential presence; a missing key degrades plate reads without failing the pipeline.</li>
            </ul>
          </Panel>
        </>
      )}
    </Shell>
  );
}
