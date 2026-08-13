import { createFileRoute } from "@tanstack/react-router";
import { Panel, Shell } from "@/components/vehicle-check";

export const Route = createFileRoute("/api-docs")({
  head: () => ({
    meta: [
      { title: "API reference — FieldSight AI" },
      {
        name: "description",
        content:
          "HTTP and RPC reference for the FieldSight AI inspection pipeline: upload, inspection fetch, status polling, analytics, health and the async worker callback.",
      },
      { property: "og:title", content: "FieldSight AI API reference" },
      {
        property: "og:description",
        content: "Endpoints, payloads and example responses for the vehicle inspection pipeline.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ApiDocsPage,
});

type Endpoint = {
  method: string;
  path: string;
  kind: "HTTP" | "RPC";
  summary: string;
  request: string;
  response: string;
};

const ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "uploadImageFn",
    kind: "RPC",
    summary:
      "Uploads a vehicle image to object storage and inserts the uploads row. Returns immediately; a database trigger enqueues analysis.",
    request: `await uploadImage({ data: {
  filename: "auto-front.jpg",
  mimeType: "image/jpeg",
  bytes: <base64 string>
} })`,
    response: `{
  "id": "0b4c…",
  "file_path": "uploads/0b4c….jpg",
  "status": "pending"
}`,
  },
  {
    method: "GET",
    path: "getUploadResultsFn",
    kind: "RPC",
    summary: "Full inspection report for one id: upload row, analysis_results row and a signed image URL.",
    request: `await getUploadResults({ data: { id: "0b4c…" } })`,
    response: `{
  "upload": { "id": "0b4c…", "status": "completed", "retry_count": 0 },
  "result": {
    "extracted_vehicle_number": "MH12NW8556",
    "vehicle_number_valid_format": true,
    "trust_score": 84,
    "ai_summary": "Vehicle registration MH12NW8556 …",
    "raw_analysis_json": { "quality_scores": [], "forensics": [], "vehicle": {} }
  },
  "image_url": "https://…"
}`,
  },
  {
    method: "GET",
    path: "listUploadsFn",
    kind: "RPC",
    summary: "Paginated inspection history with thumbnails and lifecycle status — used for polling job status.",
    request: `await listUploads({ data: { page: 1, pageSize: 20 } })`,
    response: `{
  "uploads": [ { "id": "0b4c…", "status": "processing" } ],
  "total": 34,
  "thumbnails": { "uploads/0b4c….jpg": "https://…" }
}`,
  },
  {
    method: "POST",
    path: "retryUploadFn",
    kind: "RPC",
    summary: "Re-drives a failed job through the worker. Increments the delivery counter; 3 attempts dead-letters the job.",
    request: `await retryUpload({ data: { id: "0b4c…" } })`,
    response: `{ "ok": true, "status": "pending" }`,
  },
  {
    method: "GET",
    path: "/api/public/metrics",
    kind: "HTTP",
    summary: "Machine-readable pipeline analytics: totals, queue depth by stage, issue distribution and trust histogram.",
    request: `curl https://<host>/api/public/metrics`,
    response: `{
  "totals": { "total": 34, "success_rate": 97, "avg_trust_score": 78 },
  "queue": { "pending": 4, "processing": 2, "completed": 31, "failed": 1 },
  "issues": [ { "key": "blur", "count": 3 } ]
}`,
  },
  {
    method: "GET",
    path: "/api/public/health",
    kind: "HTTP",
    summary: "Dependency probes for database, storage, worker latency and the OCR provider.",
    request: `curl https://<host>/api/public/health`,
    response: `{
  "status": "healthy",
  "components": [ { "name": "database", "status": "healthy", "latency_ms": 42 } ]
}`,
  },
  {
    method: "POST",
    path: "/api/public/analyze-image",
    kind: "HTTP",
    summary:
      "Async worker callback. Invoked by the Postgres AFTER INSERT trigger via pg_net, and by manual retries. Accepts a raw upload_id or a database-webhook record payload.",
    request: `curl -X POST https://<host>/api/public/analyze-image \\
  -H 'content-type: application/json' \\
  -d '{"upload_id":"0b4c…"}'`,
    response: `{ "ok": true, "upload_id": "0b4c…", "overall_confidence": 0.86 }`,
  },
];

const METHOD_TONE: Record<string, string> = {
  GET: "border-success/40 bg-success/10 text-success",
  POST: "border-primary/40 bg-primary/10 text-primary",
};

function ApiDocsPage() {
  return (
    <Shell
      eyebrow="Reference"
      title="API reference"
      subtitle="Every public surface of the inspection pipeline. Server functions are typed RPC calls from the app; /api/public/* routes are plain HTTP for external callers such as the database trigger."
    >
      <div className="space-y-4">
        {ENDPOINTS.map((e) => (
          <Panel key={e.path} title={e.summary}>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${METHOD_TONE[e.method] ?? ""}`}
              >
                {e.method}
              </span>
              <code className="font-mono text-sm">{e.path}</code>
              <span className="rounded-md border border-border bg-secondary/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {e.kind}
              </span>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Request</p>
                <pre className="mt-2 overflow-auto rounded-lg border border-border bg-secondary/30 p-3 font-mono text-xs">
                  {e.request}
                </pre>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Response</p>
                <pre className="mt-2 overflow-auto rounded-lg border border-border bg-secondary/30 p-3 font-mono text-xs">
                  {e.response}
                </pre>
              </div>
            </div>
          </Panel>
        ))}

        <Panel title="Processing contract" description="What callers can rely on.">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>Uploads never block on analysis — the upload call returns as soon as the row is committed.</li>
            <li>
              Status transitions are <code className="font-mono">pending → processing → completed | failed</code>, and are
              streamed over Realtime as well as being pollable.
            </li>
            <li>A failed OCR stage degrades the report rather than failing the job; every report section is always present.</li>
            <li>Three failed delivery attempts dead-letter the job; dead-lettered jobs are never auto-replayed.</li>
          </ul>
        </Panel>
      </div>
    </Shell>
  );
}
