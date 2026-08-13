import { RequireAuth } from "@/components/require-auth";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, UploadCloud } from "lucide-react";
import { listUploadsFn } from "@/lib/uploads.functions";
import { getAnalyticsFn, getHealthFn } from "@/lib/metrics.functions";
import {
  EmptyState,
  LiveBadge,
  MetricCard,
  Panel,
  Shell,
  Skeleton,
  StatusBadge,
  type UploadStatus,
} from "@/components/vehicle-check";
import { Button } from "@/components/ui/button";
import { useRealtimeUploads } from "@/hooks/use-realtime-uploads";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Operations Dashboard — FieldSight AI" },
      {
        name: "description",
        content:
          "Live operations view of the vehicle image pipeline: queue depth, throughput, success rate, trust scores and the most recent inspections.",
      },
      { property: "og:title", content: "FieldSight AI Operations Dashboard" },
      {
        property: "og:description",
        content: "Queue depth, throughput and trust scores across the vehicle inspection pipeline.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: GuardedDashboard,
});

const QUEUE_TONES: Record<string, string> = {
  pending: "text-muted-foreground",
  processing: "text-primary",
  completed: "text-success",
  failed: "text-destructive",
};

function DashboardPage() {
  const getAnalytics = useServerFn(getAnalyticsFn);
  const getHealth = useServerFn(getHealthFn);
  const list = useServerFn(listUploadsFn);
  const realtime = useRealtimeUploads("uploads-overview");

  const { data: analytics, isLoading } = useQuery({
    queryKey: ["analytics"],
    queryFn: () => getAnalytics(),
    refetchInterval: 30_000,
  });
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: () => getHealth() });
  const { data: recent } = useQuery({
    queryKey: ["uploads", 1],
    queryFn: () => list({ data: { page: 1, pageSize: 6 } }),
  });

  return (
    <Shell
      eyebrow="Operations"
      title="Pipeline overview"
      subtitle="Throughput, queue state and platform health across every inspection the worker has handled."
      actions={
        <div className="flex items-center gap-3">
          <LiveBadge state={realtime} />
          <Button asChild>
            <Link to="/upload">
              <UploadCloud className="size-4" /> New inspection
            </Link>
          </Button>
        </div>
      }
    >
      {isLoading || !analytics ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Total inspections" value={analytics.totals.total} />
          <MetricCard
            label="Success rate"
            value={`${analytics.totals.success_rate}%`}
            hint={`${analytics.totals.failed} failed · ${analytics.totals.retries} retries`}
            tone={analytics.totals.success_rate >= 90 ? "success" : "warning"}
          />
          <MetricCard
            label="In flight"
            value={analytics.totals.in_flight}
            hint="queued or being analysed"
            tone="info"
          />
          <MetricCard
            label="Avg trust score"
            value={analytics.totals.avg_trust_score}
            hint={`avg ${(analytics.totals.avg_processing_ms / 1000).toFixed(2)}s per image`}
            tone={analytics.totals.avg_trust_score >= 70 ? "success" : "warning"}
          />
        </div>
      )}

      {analytics ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <MetricCard
            label="Likely synthetic uploads"
            value={analytics.totals.ai_generated}
            hint={`${analytics.totals.ai_suspicious} suspicious · ${analytics.totals.ai_authentic} likely authentic`}
            tone={analytics.totals.ai_generated ? "danger" : "success"}
          />
          <MetricCard
            label="Duplicate submissions"
            value={analytics.totals.duplicates}
            tone={analytics.totals.duplicates ? "warning" : "success"}
          />
          <MetricCard
            label="Screenshot uploads"
            value={analytics.totals.screenshots}
            tone={analytics.totals.screenshots ? "warning" : "success"}
          />
          <MetricCard
            label="Tampering alerts"
            value={analytics.totals.tampering}
            tone={analytics.totals.tampering ? "danger" : "success"}
          />
          <MetricCard
            label="AI suspicious uploads"
            value={analytics.totals.ai_suspicious}
            hint="synthetic risk 31–70"
            tone={analytics.totals.rejected ? "danger" : "success"}
          />
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          title="Recent inspections"
          description="Newest submissions, updating live."
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to="/history">
                View all <ArrowRight className="size-4" />
              </Link>
            </Button>
          }
        >
          {!recent?.uploads.length ? (
            <EmptyState
              title="Nothing processed yet"
              description="Submit a vehicle photo to see it flow through the pipeline in real time."
              action={
                <Button asChild>
                  <Link to="/upload">
                    <UploadCloud className="size-4" /> Upload an image
                  </Link>
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {recent.uploads.map((upload) => (
                <li key={upload.id}>
                  <Link
                    to="/uploads/$id"
                    params={{ id: upload.id }}
                    className="flex items-center gap-4 py-3 transition-colors hover:bg-secondary/40"
                  >
                    <div className="size-12 shrink-0 overflow-hidden rounded-lg bg-secondary">
                      {recent.thumbnails[upload.file_path] ? (
                        <img
                          src={recent.thumbnails[upload.file_path]}
                          alt="Thumbnail of a recently inspected vehicle photograph"
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{upload.original_filename}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {new Date(upload.created_at).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge status={upload.status as UploadStatus} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Queue state" description="Jobs by lifecycle stage.">
            <ul className="space-y-3">
              {analytics
                ? Object.entries(analytics.queue).map(([stage, count]) => (
                    <li key={stage} className="flex items-center justify-between gap-3">
                      <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                        {stage}
                      </span>
                      <span className={cn("font-mono text-lg tabular-nums", QUEUE_TONES[stage])}>
                        {count}
                      </span>
                    </li>
                  ))
                : null}
            </ul>
          </Panel>

          <Panel
            title="Platform health"
            description="Dependency probes."
            action={
              <Button asChild variant="ghost" size="sm">
                <Link to="/health">
                  Details <ArrowRight className="size-4" />
                </Link>
              </Button>
            }
          >
            <ul className="space-y-2.5">
              {health?.components.map((c) => (
                <li key={c.name} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">{c.name}</span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 font-mono text-xs",
                      c.status === "healthy" ? "text-success" : "text-warning",
                    )}
                  >
                    <span className="size-1.5 rounded-full bg-current" />
                    {c.latency_ms} ms
                  </span>
                </li>
              )) ?? <Skeleton className="h-20" />}
            </ul>
          </Panel>
        </div>
      </div>
    </Shell>
  );
}


function GuardedDashboard() {
  return (
    <RequireAuth>
      <DashboardPage />
    </RequireAuth>
  );
}
