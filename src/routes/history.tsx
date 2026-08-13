import { RequireAuth } from "@/components/require-auth";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { RefreshCw, UploadCloud } from "lucide-react";
import { listUploadsFn, retryUploadFn } from "@/lib/uploads.functions";
import {
  EmptyState,
  LiveBadge,
  Shell,
  Skeleton,
  StatusBadge,
  type UploadStatus,
} from "@/components/vehicle-check";
import { Button } from "@/components/ui/button";
import { useRealtimeUploads } from "@/hooks/use-realtime-uploads";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Inspections — Screened vehicle image archive | FieldSight AI" },
      {
        name: "description",
        content:
          "Browse every vehicle image submitted to the screening pipeline, with processing status, thumbnails, failure reasons and retry controls.",
      },
      { property: "og:title", content: "FieldSight AI Inspections" },
      {
        property: "og:description",
        content: "Every vehicle image in the screening pipeline, with live status and retries.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: GuardedHistory,
});

const PAGE_SIZE = 12;

function HistoryPage() {
  const [page, setPage] = useState(1);
  const list = useServerFn(listUploadsFn);
  const retry = useServerFn(retryUploadFn);
  const queryClient = useQueryClient();
  const realtime = useRealtimeUploads("uploads-history");

  const { data, isLoading } = useQuery({
    queryKey: ["uploads", page],
    queryFn: () => list({ data: { page, pageSize: PAGE_SIZE } }),
  });

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Shell
      eyebrow="Archive"
      title="Inspections"
      subtitle="Every submission, newest first. Status updates stream in live as the worker progresses."
      actions={
        <div className="flex items-center gap-3">
          <LiveBadge state={realtime} />
          <p className="font-mono text-xs text-muted-foreground">{total} total</p>
          <Button asChild>
            <Link to="/upload">
              <UploadCloud className="size-4" /> New inspection
            </Link>
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-72" />
          ))}
        </div>
      ) : !data?.uploads.length ? (
        <EmptyState
          title="No inspections yet"
          description="Submit a vehicle photo and the pipeline will screen it for quality and authenticity issues."
          action={
            <Button asChild>
              <Link to="/upload">
                <UploadCloud className="size-4" /> Upload the first image
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.uploads.map((upload) => (
            <div
              key={upload.id}
              className="overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/50"
            >
              <div className="aspect-video bg-secondary">
                {data.thumbnails[upload.file_path] ? (
                  <img
                    src={data.thumbnails[upload.file_path]}
                    alt="Thumbnail of an inspected vehicle photograph"
                    loading="lazy"
                    className="size-full object-cover"
                  />
                ) : null}
              </div>
              <div className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-sm font-medium" title={upload.original_filename}>
                    {upload.original_filename}
                  </p>
                  <StatusBadge status={upload.status as UploadStatus} />
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  {new Date(upload.created_at).toLocaleString()} ·{" "}
                  {(upload.file_size_bytes / 1024).toFixed(0)} KB
                  {upload.retry_count > 0 ? ` · ${upload.retry_count} retries` : ""}
                </p>
                {upload.failure_reason ? (
                  <p className="line-clamp-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {upload.failure_reason}
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button asChild size="sm" variant="secondary" className="flex-1">
                    <Link to="/uploads/$id" params={{ id: upload.id }}>
                      View report
                    </Link>
                  </Button>
                  {upload.status === "failed" ? (
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={async () => {
                        await retry({ data: { id: upload.id } });
                        void queryClient.invalidateQueries({ queryKey: ["uploads"] });
                      }}
                    >
                      <RefreshCw className="size-3.5" /> Retry
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pages > 1 ? (
        <div className="mt-8 flex items-center justify-center gap-3 font-mono text-xs">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <span className="text-muted-foreground">
            page {page} / {pages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </Shell>
  );
}


function GuardedHistory() {
  return (
    <RequireAuth>
      <HistoryPage />
    </RequireAuth>
  );
}
