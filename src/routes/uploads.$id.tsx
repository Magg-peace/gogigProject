import { RequireAuth } from "@/components/require-auth";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Car,
  Check,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  MapPin,
  Wand2,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { getUploadResultsFn, retryUploadFn } from "@/lib/uploads.functions";
import { getTimelineFn } from "@/lib/metrics.functions";
import { Panel, Shell, Skeleton, StatusBadge, type UploadStatus } from "@/components/vehicle-check";
import { decodeRto, formatPlate } from "@/lib/rto";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/uploads/$id")({
  head: () => ({
    meta: [
      { title: "Inspection report — FieldSight AI" },
      {
        name: "description",
        content:
          "Full vehicle inspection report: vehicle detection, plate OCR, RTO intelligence, quality score cards, forensic checks, weighted trust score and audit timeline.",
      },
      { property: "og:title", content: "Inspection report — FieldSight AI" },
      {
        property: "og:description",
        content: "Explainable vehicle image verification you can defend in an audit.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: GuardedDetail,
});

type QualityScore = { key: string; label: string; score: number; basis: string };
type ForensicCheck = {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  confidence: number;
  explanation: string;
  evidence: string;
  recommendation: string;
};
type Component = { key: string; label: string; weight: number; score: number; contribution: number; basis: string };
type Entity = { type: string; value: string; confidence: number };
type Bbox = [number, number, number, number];
type AiCheck = {
  key: string;
  label: string;
  signal: number;
  weight: number;
  contribution?: number;
  evidence: string;
};
type SyntheticRisk = {
  synthetic_risk_score?: number;
  authenticity_score?: number;
  assessment_confidence?: number;
  ai_confidence: number;
  ai_confidence_pct: number;
  verdict: string;
  checks: AiCheck[];
  evidence?: string[];
  recommendation?: string;
  notes: string[];
};

type RawAnalysis = {
  version?: number;
  quality_scores?: QualityScore[];
  forensics?: ForensicCheck[];
  trust?: {
    trust_score?: number;
    base_trust_score?: number;
    ai_deduction?: number;
    risk_level?: string;
    verdict?: string;
    components?: Component[];
    weight_total?: number;
  };
  synthetic_risk?: SyntheticRisk;
  ai_detection?: SyntheticRisk;
  rto?: ReturnType<typeof decodeRto>;
  contrast?: { contrast_stddev: number; dynamic_range: number };
  overlay?: { overlay_band_detected: boolean; overlay_edge: string | null; overlay_band_ratio: number };
  ocr?: {
    model_confidence: number;
    note: string;
    plate_bbox?: Bbox | null;
    entities?: Entity[];
    full_text?: string | null;
  };
  ocr_status?: { status: "ok" | "failed"; error: string | null; duration_ms?: number };
  vehicle?: {
    detected: boolean;
    type: string | null;
    confidence: number;
    bbox: Bbox | null;
    colour: string | null;
    visibility: number;
    status: "ok" | "unavailable";
  };
  blur?: { blur_score: number; blur_confidence: number };
  brightness?: { brightness_score: number; dark_pixel_ratio: number };
  duplicate?: { nearest_distance: number | null };
  processing_logs?: Array<{ step: string; status: string; ms: number; detail?: unknown }>;
};

const ENTITY_LABELS: Record<string, string> = {
  vehicle_number: "Vehicle number",
  phone: "Phone number",
  task_id: "Task ID",
  date: "Date",
  time: "Time",
  address: "Address",
  gps: "GPS coordinates",
  business_name: "Business name",
  advertisement: "Advertisement text",
  other: "Other text",
};

/**
 * Color-coded risk banding. The worker's stored band wins when present because
 * it already accounts for the synthetic-image override (>85% -> high risk,
 * >95% -> rejected); the numeric fallback is only for legacy reports.
 */
function riskBand(score: number | null, stored?: string | undefined) {
  const map = {
    REJECTED: { label: "REJECTED", tone: "text-destructive", chip: "border-destructive/60 bg-destructive/20 text-destructive", bar: "bg-destructive" },
    "HIGH RISK": { label: "HIGH RISK", tone: "text-destructive", chip: "border-destructive/40 bg-destructive/10 text-destructive", bar: "bg-destructive" },
    "MEDIUM RISK": { label: "MEDIUM RISK", tone: "text-warning", chip: "border-warning/40 bg-warning/10 text-warning", bar: "bg-warning" },
    "LOW RISK": { label: "LOW RISK", tone: "text-success", chip: "border-success/40 bg-success/10 text-success", bar: "bg-success" },
    VERIFIED: { label: "VERIFIED", tone: "text-success", chip: "border-success/40 bg-success/10 text-success", bar: "bg-success" },
  } as const;
  const key = (stored ?? "").toUpperCase() as keyof typeof map;
  if (map[key]) return map[key];
  if (score == null)
    return { label: "PENDING", tone: "text-muted-foreground", chip: "border-border bg-secondary/40 text-muted-foreground", bar: "bg-muted-foreground" };
  if (score >= 90) return map.VERIFIED;
  if (score >= 70) return map["LOW RISK"];
  if (score >= 50) return map["MEDIUM RISK"];
  return map["HIGH RISK"];
}

const PIPELINE_STAGES = [
  { key: "UPLOAD", events: ["UPLOAD_RECEIVED", "UPLOAD_CREATED"] },
  { key: "QUEUED", events: ["ANALYSIS_ENQUEUED", "QUEUED"] },
  { key: "PROCESSING", events: ["PROCESSING_STARTED", "IMAGE_DECODED"] },
  { key: "OCR", events: ["OCR_COMPLETED"] },
  { key: "AI SCAN", events: ["AI_SYNTHESIS_ANALYSED"] },
  { key: "FORENSICS", events: ["QUALITY_ANALYSIS_COMPLETED"] },
  { key: "SCORING", events: ["CONFIDENCE_CALCULATED"] },
  { key: "COMPLETED", events: ["REPORT_GENERATED"] },
] as const;

function DetailPage() {
  const { id } = Route.useParams();
  const fetchResults = useServerFn(getUploadResultsFn);
  const retry = useServerFn(retryUploadFn);
  const queryClient = useQueryClient();
  const fetchTimeline = useServerFn(getTimelineFn);
  const [showRaw, setShowRaw] = useState(false);
  const [showBox, setShowBox] = useState(true);

  const { data, isLoading } = useQuery({
    queryKey: ["upload", id],
    queryFn: () => fetchResults({ data: { id } }),
  });

  const { data: timeline } = useQuery({
    queryKey: ["timeline", id],
    queryFn: () => fetchTimeline({ data: { id } }),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const channel = supabase
      .channel(`upload-detail-${id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "uploads", filter: `id=eq.${id}` },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["upload", id] });
          void queryClient.invalidateQueries({ queryKey: ["timeline", id] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, queryClient]);

  const raw = (data?.result?.raw_analysis_json ?? {}) as RawAnalysis;
  const rto = useMemo(
    () => raw.rto ?? decodeRto(data?.result?.extracted_vehicle_number ?? null),
    [raw.rto, data?.result?.extracted_vehicle_number],
  );

  if (isLoading || !data) {
    return (
      <Shell eyebrow="Inspection" title="Loading report…">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </Shell>
    );
  }

  const { upload, result, image_url } = data;
  const pending = !result;
  const num = (value: unknown) => (value == null ? 0 : Number(value));
  const trust = result?.trust_score == null ? null : Number(result.trust_score);
  const aiRaw = raw.synthetic_risk ?? raw.ai_detection ?? null;
  const ai = aiRaw
    ? {
        ...aiRaw,
        synthetic_risk_score: aiRaw.synthetic_risk_score ?? aiRaw.ai_confidence_pct,
        authenticity_score: aiRaw.authenticity_score ?? 100 - aiRaw.ai_confidence_pct,
      }
    : null;
  const band = riskBand(trust, raw.trust?.risk_level);
  const bbox = raw.ocr?.plate_bbox ?? null;
  const entities = raw.ocr?.entities ?? [];
  const ocrFailed = raw.ocr_status?.status === "failed";
  const components = raw.trust?.components ?? [];
  const vehicle = raw.vehicle ?? null;

  // Explainability: what pushed the score up, what pulled it down.
  const positives = components.filter((c) => c.score >= 0.7).map((c) => `${c.label} — ${Math.round(c.score * 100)}%`);
  const negatives = components.filter((c) => c.score < 0.5).map((c) => `${c.label} — only ${Math.round(c.score * 100)}%`);
  for (const f of raw.forensics ?? []) {
    if (f.status === "fail") negatives.push(`${f.label} flagged (${f.confidence}% confidence)`);
  }
  if (raw.trust?.ai_deduction) {
    negatives.push(`Synthetic-risk deduction — ${raw.trust.ai_deduction} points removed from the base score`);
  }

  const forensicFailures = (raw.forensics ?? []).filter((f) => f.status === "fail").length;
  const forensicWarnings = (raw.forensics ?? []).filter((f) => f.status === "warn").length;
  const ocrPct = Math.round(num(raw.ocr?.model_confidence) * 100);

  const chartData = components.map((c) => ({
    name: c.label,
    value: Math.round(c.score * 100),
    weight: c.weight,
  }));

  const stageStatus = (events: readonly string[]) =>
    (timeline ?? []).some((e) => events.includes(e.event));

  const download = (filename: string, mime: string, content: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportJson = () =>
    download(`fieldsight-${id}.json`, "application/json", JSON.stringify({ upload, result }, null, 2));
  const exportCsv = () => {
    const rows: string[][] = [["field", "value"]];
    rows.push(["inspection_id", upload.id]);
    rows.push(["filename", upload.original_filename]);
    rows.push(["status", upload.status]);
    rows.push(["vehicle_number", result?.extracted_vehicle_number ?? ""]);
    rows.push(["plate_valid", String(result?.vehicle_number_valid_format ?? "")]);
    rows.push(["vehicle_type", vehicle?.type ?? ""]);
    rows.push(["state", rto?.state ?? ""]);
    rows.push(["rto_office", rto?.rto_office ?? ""]);
    rows.push(["trust_score", String(trust ?? "")]);
    rows.push(["risk_band", band.label]);
    rows.push(["synthetic_risk_score", ai ? `${ai.synthetic_risk_score}/100` : ""]);
    rows.push(["authenticity_score", ai ? `${ai.authenticity_score}/100` : ""]);
    rows.push(["synthetic_verdict", ai?.verdict ?? ""]);
    rows.push(["assessment_confidence", ai?.assessment_confidence == null ? "" : `${ai.assessment_confidence}%`]);
    rows.push(["synthetic_recommendation", ai?.recommendation ?? ""]);
    for (const c of ai?.checks ?? []) rows.push([`synthetic.${c.key}`, `${Math.round(c.signal * 100)}%`]);
    for (const q of raw.quality_scores ?? []) rows.push([`quality.${q.key}`, `${q.score}/10`]);
    for (const f of raw.forensics ?? []) rows.push([`forensic.${f.key}`, `${f.status} (${f.confidence}%)`]);
    for (const e of entities) rows.push([`entity.${e.type}`, e.value]);
    download(
      `fieldsight-${id}.csv`,
      "text/csv",
      rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n"),
    );
  };

  return (
    <Shell
      eyebrow="Inspection report"
      title="Vehicle image inspection report"
      subtitle={`${upload.original_filename} · ${upload.id} · ${new Date(upload.created_at).toLocaleString()} · ${(upload.file_size_bytes / 1024).toFixed(0)} KB · ${upload.mime_type} · attempts ${upload.retry_count + 1}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={upload.status as UploadStatus} />
          <span className={cn("rounded-full border px-3 py-1 font-mono text-[11px] tracking-widest", band.chip)}>
            {band.label}
          </span>
          <Button size="sm" variant="outline" onClick={exportJson}>
            <Download className="size-3.5" /> JSON
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv}>
            <Download className="size-3.5" /> CSV
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            <Download className="size-3.5" /> PDF
          </Button>
          {upload.status === "failed" ? (
            <Button
              size="sm"
              onClick={async () => {
                await retry({ data: { id } });
                void queryClient.invalidateQueries({ queryKey: ["upload", id] });
              }}
            >
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          ) : null}
        </div>
      }
    >
      <Link to="/history" className="font-mono text-xs text-muted-foreground hover:text-foreground">
        ← back to inspections
      </Link>

      {upload.failure_reason ? (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-destructive/50 bg-destructive/10 p-5">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">Analysis failed</p>
            <p className="mt-1 font-mono text-sm text-destructive/90">{upload.failure_reason}</p>
          </div>
        </div>
      ) : null}

      {pending ? (
        <div className="mt-6 rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
          {upload.status === "failed"
            ? "No analysis results were written for this inspection — every section below is shown in its degraded state so the report structure stays comparable across inspections."
            : "Analysis is still running. Every section is rendered below and fills in automatically as the worker reports."}
        </div>
      ) : null}

      <div className="mt-6 space-y-6">
        {/* 0 — FORENSIC SUMMARY */}
        <Panel
          title="Forensic summary"
          description="Every check that ran on this frame, at a glance. All checks are listed on every report — including the ones that passed."
          action={
            <span className={cn("rounded-full border px-3 py-1 font-mono text-[11px] tracking-widest", band.chip)}>
              OVERALL RISK · {band.label}
            </span>
          }
        >
          {(raw.forensics ?? []).length ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(raw.forensics ?? []).map((f) => (
                  <div
                    key={`sum-${f.key}`}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-lg border px-3 py-2",
                      f.status === "pass"
                        ? "border-success/30 bg-success/5"
                        : f.status === "warn"
                          ? "border-warning/30 bg-warning/5"
                          : "border-destructive/30 bg-destructive/5",
                    )}
                  >
                    <span className="min-w-0 truncate text-sm">{f.label}</span>
                    <StatusPill status={f.status} />
                  </div>
                ))}
              </div>
              <p className="mt-4 font-mono text-xs text-muted-foreground">
                {forensicFailures} failed · {forensicWarnings} advisory ·{" "}
                {(raw.forensics ?? []).length - forensicFailures - forensicWarnings} passed · trust{" "}
                {trust ?? "—"}/100
              </p>
            </>
          ) : (
            <Degraded reason="Forensic checks have not reported for this inspection yet." />
          )}
        </Panel>

        {/* 1 — VEHICLE REGISTRATION, SIDE BY SIDE */}
        <Panel
          title="1 · Detected vehicle registration"
          description="Original frame with the detected plate overlay on the left, the extracted plate crop on the right."
          action={
            <Button size="sm" variant="outline" onClick={() => setShowBox((v) => !v)} disabled={!bbox}>
              {showBox ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {showBox ? "Hide bounding box" : "Show bounding box"}
            </Button>
          }
        >
          <div className="grid gap-6 lg:grid-cols-2">
            {/* LEFT — original with overlay */}
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Original image {bbox && showBox ? "· plate overlay on" : ""}
              </p>
              <div className="relative mt-2 overflow-hidden rounded-lg border border-border bg-secondary/40">
                {image_url ? (
                  <>
                    <img
                      src={image_url}
                      alt="Original uploaded vehicle photograph with the detected number plate highlighted"
                      className="w-full"
                    />
                    {bbox && showBox ? (
                      <span
                        className="pointer-events-none absolute rounded-sm border-2 border-success shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                        style={{
                          left: `${bbox[0] * 100}%`,
                          top: `${bbox[1] * 100}%`,
                          width: `${bbox[2] * 100}%`,
                          height: `${bbox[3] * 100}%`,
                        }}
                      >
                        <span className="absolute -top-6 left-0 whitespace-nowrap rounded bg-success px-1.5 py-0.5 font-mono text-[10px] font-semibold text-background">
                          PLATE {ocrPct}%
                        </span>
                      </span>
                    ) : null}
                  </>
                ) : (
                  <div className="grid h-40 place-items-center text-xs text-muted-foreground">
                    Image preview unavailable
                  </div>
                )}
              </div>
              <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                {bbox
                  ? `bbox x ${bbox[0].toFixed(3)} · y ${bbox[1].toFixed(3)} · w ${bbox[2].toFixed(3)} · h ${bbox[3].toFixed(3)} (normalised)`
                  : "no bounding box was returned for this frame"}
              </p>
            </div>

            {/* RIGHT — plate crop */}
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Detected plate crop
              </p>
              <div className="relative mt-2 overflow-hidden rounded-lg border border-border bg-secondary/40">
                {image_url ? (
                  bbox ? (
                    <div className="relative aspect-video overflow-hidden">
                      <img
                        src={image_url}
                        alt="Cropped registration plate region detected in the vehicle photograph"
                        className="absolute max-w-none origin-top-left"
                        style={{
                          width: `${100 / Math.max(0.02, bbox[2])}%`,
                          left: `${(-bbox[0] / Math.max(0.02, bbox[2])) * 100}%`,
                          top: `${(-bbox[1] / Math.max(0.02, bbox[3])) * 100}%`,
                        }}
                      />
                    </div>
                  ) : (
                    <img
                      src={image_url}
                      alt="Full uploaded vehicle photograph shown because no plate region was localised"
                      className="w-full"
                    />
                  )
                ) : (
                  <div className="grid h-40 place-items-center text-xs text-muted-foreground">
                    Image preview unavailable
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {bbox
                  ? "Crop derived from the model-reported normalised bounding box."
                  : "No bounding box returned — showing the full frame."}
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Vehicle number
              </p>
              <p className="mt-2 inline-block rounded-lg border-2 border-foreground/70 bg-background px-4 py-2 font-mono text-3xl font-bold tracking-[0.15em]">
                {formatPlate(result?.extracted_vehicle_number ?? null) || "NOT DETECTED"}
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Meter label="OCR confidence" value={ocrPct} />
                <Meter label="Plate confidence" value={ocrPct} />
                <Field
                  label="Plate validation"
                  value={
                    result?.vehicle_number_valid_format
                      ? "Valid format"
                      : result?.extracted_vehicle_number
                        ? "Format mismatch"
                        : ocrFailed
                          ? "Unavailable — OCR failed"
                          : "No plate read"
                  }
                  tone={result?.vehicle_number_valid_format ? "success" : "danger"}
                />
                <Field
                  label="Bounding box dimensions"
                  value={
                    bbox && result?.image_width
                      ? `${Math.round(bbox[2] * Number(result.image_width))} × ${Math.round(bbox[3] * Number(result.image_height))} px (${(bbox[2] * 100).toFixed(1)}% × ${(bbox[3] * 100).toFixed(1)}% of frame)`
                      : bbox
                        ? bbox.map((v) => v.toFixed(3)).join(", ")
                        : "not localised"
                  }
                />
                <Field label="Raw OCR string" value={result?.extracted_vehicle_number ?? "—"} />
              </div>
              {result?.vehicle_number_valid_format ? (
                <span className="mt-4 inline-flex items-center gap-2 rounded-full border border-success/40 bg-success/10 px-3 py-1.5 text-xs font-medium text-success">
                  <BadgeCheck className="size-4" /> Official Indian MoRTH compliant plate format
                </span>
              ) : null}
            </div>
            <div className="rounded-xl border border-border bg-card/40 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Overlay controls
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                The green box is drawn from the vision model's normalised coordinates and is an estimate, like every
                other value on this report. Toggle it off to inspect the untouched frame.
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-3 w-full"
                onClick={() => setShowBox((v) => !v)}
                disabled={!bbox}
              >
                {showBox ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                {showBox ? "Hide bounding box" : "Show bounding box"}
              </Button>
            </div>
          </div>
        </Panel>

        {/* 2 — VEHICLE DETECTION */}
        <Panel
          title="2 · Vehicle detection"
          description="Scene-level detection of the vehicle itself, independent of the plate read."
        >
          {vehicle && vehicle.status === "ok" ? (
            <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Vehicle detected"
                  value={vehicle.detected ? "Yes" : "No vehicle found in frame"}
                  tone={vehicle.detected ? "success" : "danger"}
                  icon={<Car className="size-3.5" />}
                />
                <Field label="Vehicle type" value={vehicle.type ?? "Unclassified"} />
                <Meter label="Detection confidence" value={Math.round(num(vehicle.confidence) * 100)} />
                <Meter label="Vehicle visibility" value={Math.round(num(vehicle.visibility) * 100)} />
                <Field label="Dominant colour" value={vehicle.colour ?? "Not determined"} />
                <Field
                  label="Bounding box (x, y, w, h)"
                  value={vehicle.bbox ? vehicle.bbox.map((v) => v.toFixed(3)).join(", ") : "not localised"}
                />
              </div>
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  Vehicle overlay
                </p>
                <div className="relative mt-2 overflow-hidden rounded-lg border border-border bg-secondary/40">
                  {image_url ? (
                    <>
                      <img src={image_url} alt="Vehicle photograph with detection bounding box overlay" className="w-full" />
                      {vehicle.bbox ? (
                        <span
                          className="pointer-events-none absolute rounded border-2 border-success"
                          style={{
                            left: `${vehicle.bbox[0] * 100}%`,
                            top: `${vehicle.bbox[1] * 100}%`,
                            width: `${vehicle.bbox[2] * 100}%`,
                            height: `${vehicle.bbox[3] * 100}%`,
                          }}
                        />
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <Degraded
              reason={
                ocrFailed
                  ? `Vision stage failed (${raw.ocr_status?.error ?? "unknown error"}), so vehicle detection is unavailable for this inspection.`
                  : pending
                    ? "Vehicle detection runs in the vision stage — it will appear as soon as the worker finishes."
                    : "This inspection was analysed before vehicle detection existed. Re-run the analysis to populate it."
              }
            />
          )}
        </Panel>

        {/* 3 — OCR RESULTS */}
        <Panel title="3 · OCR results" description="Status, confidence and full text of the vision read.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="OCR status"
              value={ocrFailed ? "Failed" : pending ? "Pending" : result?.extracted_vehicle_number ? "Success" : "Completed — no plate read"}
              tone={ocrFailed ? "danger" : result?.extracted_vehicle_number ? "success" : undefined}
            />
            <Meter label="Model confidence" value={Math.round(num(raw.ocr?.model_confidence) * 100)} />
            <Field label="Duration" value={raw.ocr_status?.duration_ms ? `${raw.ocr_status.duration_ms} ms` : "—"} />
            <Field label="Entities extracted" value={String(entities.length)} />
          </div>
          {ocrFailed ? (
            <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
              <p className="font-medium text-destructive">OCR stage failed — remaining analyses continued.</p>
              <p className="mt-1 font-mono text-xs text-destructive/90">{raw.ocr_status?.error}</p>
            </div>
          ) : null}
          {raw.ocr?.full_text ? (
            <details className="mt-4" open>
              <summary className="cursor-pointer font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Full extracted text
              </summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-secondary/30 p-3 font-mono text-xs">
                {raw.ocr.full_text}
              </pre>
            </details>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">No free text was captured for this frame.</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            <ScanLine className="mr-1 inline size-3.5" />
            {raw.ocr?.note ?? "OCR output is probabilistic and must be confirmed before operational use."}
          </p>
        </Panel>

        {/* 4 — RTO INTELLIGENCE */}
        <Panel
          title="4 · Indian RTO intelligence"
          description="Deterministic offline decode of the registration string — no registry call is made."
        >
          {rto?.parts ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="State" value={rto.state ?? "Unknown state code"} icon={<MapPin className="size-3.5" />} />
                <Field label="RTO office" value={rto.rto_office ?? "Not in offline table"} />
                <Field label="District" value={rto.district ?? "—"} />
                <Field label="Registration category" value={rto.category} />
              </div>
              <div className="mt-4 flex flex-wrap gap-2 font-mono text-xs">
                {(["state_code", "rto_code", "series", "serial"] as const).map((k) => (
                  <span key={k} className="rounded-md border border-border bg-secondary/40 px-2.5 py-1">
                    <span className="text-muted-foreground">{k}</span> {rto.parts![k]}
                  </span>
                ))}
                <span className="rounded-md border border-border bg-secondary/40 px-2.5 py-1">
                  <span className="text-muted-foreground">decode confidence</span>{" "}
                  {Math.round(rto.decode_confidence * 100)}%
                </span>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{rto.category_basis}</p>
              {rto.notes.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {rto.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <Degraded
              reason={
                ocrFailed
                  ? "Unable to decode registration — the OCR stage failed, so no registration string reached the RTO decoder."
                  : "Unable to decode registration — no plate string was read from this frame."
              }
            />
          )}
        </Panel>

        {/* 5 — IMAGE QUALITY */}
        <Panel
          title="5 · Image quality analysis"
          description="Score cards on a 0–10 scale, each derived from one measurable pixel statistic."
        >
          {(raw.quality_scores ?? []).length ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(raw.quality_scores ?? []).map((q) => (
                <div key={q.key} className="rounded-xl border border-border bg-card/60 p-4">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium">{q.label}</span>
                    <span
                      className={cn(
                        "font-mono text-lg font-semibold tabular-nums",
                        q.score >= 7 ? "text-success" : q.score >= 4 ? "text-warning" : "text-destructive",
                      )}
                    >
                      {q.score.toFixed(1)}
                      <span className="text-xs text-muted-foreground">/10</span>
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        q.score >= 7 ? "bg-success" : q.score >= 4 ? "bg-warning" : "bg-destructive",
                      )}
                      style={{ width: `${q.score * 10}%` }}
                    />
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">{q.basis}</p>
                </div>
              ))}
            </div>
          ) : (
            <Degraded
              reason={
                pending
                  ? "Quality score cards are produced by the pixel analysis stage and will appear when it completes."
                  : "No quality score cards were written for this inspection. Re-run the analysis to populate them."
              }
            />
          )}
        </Panel>

        {/* 6 — FORENSIC ANALYSIS */}
        <Panel
          title="6 · Forensic image analysis"
          description="Each check reports status, confidence, the evidence it fired on, and the recommended action."
        >
          {(raw.forensics ?? []).length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {(raw.forensics ?? []).map((f) => (
                <div key={f.key} className="rounded-xl border border-border bg-card/60 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium">{f.label}</span>
                    <StatusPill status={f.status} />
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{f.confidence}% confidence</p>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        f.status === "pass" ? "bg-success" : f.status === "warn" ? "bg-warning" : "bg-destructive",
                      )}
                      style={{ width: `${f.confidence}%` }}
                    />
                  </div>
                  <dl className="mt-3 space-y-2 text-xs">
                    <div>
                      <dt className="font-mono uppercase tracking-widest text-muted-foreground">Explanation</dt>
                      <dd className="mt-0.5">{f.explanation}</dd>
                    </div>
                    <div>
                      <dt className="font-mono uppercase tracking-widest text-muted-foreground">Evidence</dt>
                      <dd className="mt-0.5 text-muted-foreground">{f.evidence}</dd>
                    </div>
                    <div>
                      <dt className="font-mono uppercase tracking-widest text-muted-foreground">Recommendation</dt>
                      <dd className="mt-0.5 text-muted-foreground">{f.recommendation}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          ) : (
            <Degraded
              reason={
                pending
                  ? "Forensic checks run on the raw pixel buffer and will appear when the worker completes."
                  : "Forensic checks did not produce output for this inspection."
              }
            />
          )}
        </Panel>

        {/* 6.1 — AI AUTHENTICITY ASSESSMENT */}
        <Panel
          title="6.1 · AI Authenticity Assessment"
          description="Synthetic Image Risk Assessment — nine fused checks estimating whether this frame may be AI-generated, digitally synthesised, heavily edited or otherwise not an original field photograph. Heuristic risk indicator, never a definitive forensic determination."
        >
          {ai ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div
                  className={cn(
                    "rounded-xl border p-4",
                    ai.authenticity_score >= 70
                      ? "border-success/40 bg-success/10"
                      : ai.authenticity_score >= 30
                        ? "border-warning/40 bg-warning/10"
                        : "border-destructive/40 bg-destructive/10",
                  )}
                >
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                    Authenticity score
                  </p>
                  <p className="mt-2 text-4xl font-semibold tabular-nums">
                    {ai.authenticity_score}
                    <span className="text-base text-muted-foreground">/100</span>
                  </p>
                </div>
                <div
                  className={cn(
                    "rounded-xl border p-4",
                    ai.synthetic_risk_score > 70
                      ? "border-destructive/40 bg-destructive/10"
                      : ai.synthetic_risk_score > 30
                        ? "border-warning/40 bg-warning/10"
                        : "border-success/40 bg-success/10",
                  )}
                >
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                    Synthetic risk score
                  </p>
                  <p className="mt-2 text-4xl font-semibold tabular-nums">
                    {ai.synthetic_risk_score}
                    <span className="text-base text-muted-foreground">/100</span>
                  </p>
                  {raw.trust?.ai_deduction ? (
                    <p className="mt-2 font-mono text-[11px] text-destructive">
                      −{raw.trust.ai_deduction} trust points applied
                    </p>
                  ) : null}
                </div>
                <div className="rounded-xl border border-border bg-card/40 p-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                    Verdict
                  </p>
                  <p
                    className={cn(
                      "mt-3 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-widest",
                      ai.verdict === "Likely Synthetic"
                        ? "border-destructive/50 bg-destructive/15 text-destructive"
                        : ai.verdict === "Suspicious"
                          ? "border-warning/50 bg-warning/15 text-warning"
                          : "border-success/50 bg-success/15 text-success",
                    )}
                  >
                    <Wand2 className="size-3.5" /> {ai.verdict}
                  </p>
                  <ul className="mt-3 space-y-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    <li>0–30 · likely authentic</li>
                    <li>31–70 · suspicious</li>
                    <li>71–100 · likely synthetic</li>
                  </ul>
                </div>
                <div className="rounded-xl border border-border bg-card/40 p-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                    Assessment confidence
                  </p>
                  <p className="mt-2 text-4xl font-semibold tabular-nums">
                    {ai.assessment_confidence ?? "—"}
                    {ai.assessment_confidence == null ? null : <span className="text-base">%</span>}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    How much evidence (metadata, vision reading, resolution) the assessment had to work with.
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-3">
                  {ai.checks.map((c) => (
                    <div key={c.key} className="rounded-lg border border-border bg-card/40 p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm">{c.label}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          risk signal {Math.round(c.signal * 100)}% · weight {Math.round(c.weight * 100)}%
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            c.signal > 0.7 ? "bg-destructive" : c.signal > 0.3 ? "bg-warning" : "bg-success",
                          )}
                          style={{ width: `${Math.max(2, c.signal * 100)}%` }}
                        />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">{c.evidence}</p>
                    </div>
                  ))}
                </div>
                <div className="space-y-4">
                  <div className="rounded-xl border border-border bg-card/40 p-4">
                    <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                      Evidence
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                      {(ai.evidence ?? ai.checks.filter((c) => c.signal >= 0.25).map((c) => `${c.label}: ${c.evidence}`)).map(
                        (e) => (
                          <li key={e}>{e}</li>
                        ),
                      )}
                    </ul>
                  </div>
                  <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
                    <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
                      Recommendation
                    </p>
                    <p className="mt-2 text-sm">
                      {ai.recommendation ??
                        "Treat the score as a risk indicator and corroborate with the field agent where it matters."}
                    </p>
                  </div>
                  {ai.notes.length ? (
                    <div className="rounded-xl border border-border bg-card/40 p-4">
                      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                        Reasoning notes
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                        {ai.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <Degraded
              reason={
                pending
                  ? "The Synthetic Image Risk Assessment runs alongside the forensic stage and will appear when the worker completes."
                  : "This inspection was analysed before the Synthetic Image Risk Assessment module existed. Re-run the analysis to populate it."
              }
            />
          )}
        </Panel>

        {/* 7 — OCR ENTITIES */}
        <Panel
          title="7 · OCR entities"
          description="Every text entity the vision model could read, with its own confidence."
        >
          {entities.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    <th className="pb-2">Entity</th>
                    <th className="pb-2">Value</th>
                    <th className="pb-2 text-right">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {entities.map((e, index) => (
                    <tr key={`${e.type}-${index}`} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-4 text-muted-foreground">{ENTITY_LABELS[e.type] ?? e.type}</td>
                      <td className="py-2 pr-4 font-mono">{e.value}</td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {Math.round(e.confidence * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Degraded
              reason={
                ocrFailed
                  ? "Entity extraction is unavailable because the vision stage failed."
                  : "No text entities beyond the registration plate were legible in this frame."
              }
            />
          )}
        </Panel>

        {/* 8 — CONFIDENCE ENGINE */}
        <Panel
          title="8 · Confidence engine"
          description={`Weighted components${raw.trust?.weight_total ? ` (raw weights sum to ${raw.trust.weight_total}, normalised to 100)` : ""}.`}
        >
          <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
            <div className="rounded-xl border border-border bg-card/60 p-5 text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Trust score
              </p>
              <p className={cn("mt-2 text-6xl font-semibold tabular-nums", band.tone)}>{trust ?? "—"}</p>
              <p className="font-mono text-xs text-muted-foreground">/ 100</p>
              <span
                className={cn(
                  "mt-4 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[11px] tracking-widest",
                  band.chip,
                )}
              >
                <ShieldAlert className="size-3.5" /> {band.label}
              </span>
              <p className="mt-3 text-xs text-muted-foreground">{raw.trust?.verdict ?? "Awaiting scoring."}</p>
              {result?.processing_ms ? (
                <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                  processed in {(Number(result.processing_ms) / 1000).toFixed(2)}s
                </p>
              ) : null}
              <ul className="mt-4 space-y-1 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <li>90–100 · verified</li>
                <li>70–89 · low risk</li>
                <li>50–69 · medium risk</li>
                <li>0–49 · high risk</li>
                <li>ai &gt; 95% · rejected</li>
              </ul>
            </div>
            <div className="space-y-4">
              {chartData.length ? (
                <div className="h-64 w-full rounded-xl border border-border bg-card/40 p-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} layout="vertical" margin={{ left: 40, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis type="number" domain={[0, 100]} stroke="var(--muted-foreground)" fontSize={11} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={130}
                        stroke="var(--muted-foreground)"
                        fontSize={11}
                      />
                      <Tooltip
                        cursor={{ fill: "var(--secondary)" }}
                        contentStyle={{
                          background: "var(--card)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(v: number, _n, p) => [`${v}% (weight ${p.payload.weight}%)`, "Component"]}
                      />
                      <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                        {chartData.map((d) => (
                          <Cell
                            key={d.name}
                            fill={d.value >= 70 ? "var(--success)" : d.value >= 40 ? "var(--warning)" : "var(--destructive)"}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <Degraded reason="Component breakdown appears once scoring has run." />
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-success/30 bg-success/5 p-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-success">
                    Why the score is {trust ?? "—"} · positives
                  </p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {positives.length ? (
                      positives.map((p) => (
                        <li key={p} className="flex gap-2">
                          <Check className="mt-0.5 size-3.5 shrink-0 text-success" /> {p}
                        </li>
                      ))
                    ) : (
                      <li className="text-muted-foreground">No component scored strongly.</li>
                    )}
                  </ul>
                </div>
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-destructive">Negatives</p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {negatives.length ? (
                      negatives.map((n) => (
                        <li key={n} className="flex gap-2">
                          <X className="mt-0.5 size-3.5 shrink-0 text-destructive" /> {n}
                        </li>
                      ))
                    ) : (
                      <li className="text-muted-foreground">Nothing pulled the score down.</li>
                    )}
                  </ul>
                </div>
              </div>

              <div className="space-y-2">
                {components.map((c) => (
                  <div key={c.key} className="rounded-lg border border-border bg-card/40 p-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm">{c.label}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        weight {c.weight}% · score {Math.round(c.score * 100)}% · +{c.contribution.toFixed(1)}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${c.score * 100}%` }} />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{c.basis}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>

        {/* 9 — AI SUMMARY */}
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-6">
          <p className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
            <Sparkles className="size-3.5" /> 9 · AI assessment summary
          </p>
          <p className="mt-3 text-base leading-relaxed">
            {result?.ai_summary ??
              (upload.status === "failed"
                ? "No assessment could be written because the analysis job failed before scoring."
                : "The assessment is written once every check has reported. It will appear here automatically.")}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Written deterministically from the stored metrics so the narrative can never contradict the numbers
            it describes.
          </p>
        </div>

        {/* 10 — AUDIT TIMELINE */}
        <Panel
          title="10 · Audit timeline"
          description="Durable, append-only record of every lifecycle transition for this inspection."
        >
          <div className="flex flex-wrap items-center gap-2">
            {PIPELINE_STAGES.map((stage, index) => {
              const done = stageStatus(stage.events);
              return (
                <div key={stage.key} className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest",
                      done
                        ? "border-success/40 bg-success/10 text-success"
                        : "border-border bg-secondary/40 text-muted-foreground",
                    )}
                  >
                    {stage.key}
                  </span>
                  {index < PIPELINE_STAGES.length - 1 ? (
                    <span className="font-mono text-xs text-muted-foreground">→</span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="mt-5">
            {timeline?.length ? (
              <ol className="relative space-y-4 border-l border-border pl-5">
                {timeline.map((event) => (
                  <li key={event.id} className="relative">
                    <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full border-2 border-background bg-primary" />
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-mono text-xs uppercase tracking-widest text-foreground">{event.event}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {new Date(event.created_at).toLocaleString()}
                        {event.duration_ms ? ` · ${event.duration_ms}ms` : ""}
                      </p>
                    </div>
                    {event.message ? (
                      <p className="mt-1 text-sm text-muted-foreground">{event.message}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <Degraded reason="No audit events recorded yet for this inspection." />
            )}
          </div>
        </Panel>

        {/* 11 — WORKER LOGS & RETRIES */}
        <Panel
          title="11 · Worker logs & delivery attempts"
          description="Per-step worker timings plus the delivery counter used by the dead-letter policy."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Delivery attempts" value={String(upload.retry_count + 1)} />
            <Field
              label="Last failure reason"
              value={upload.failure_reason ?? "none"}
              tone={upload.failure_reason ? "danger" : undefined}
            />
            <Field
              label="Job state"
              value={upload.retry_count >= 3 ? "Dead-lettered" : upload.status}
              tone={upload.retry_count >= 3 ? "danger" : undefined}
            />
          </div>
          {raw.processing_logs?.length ? (
            <ul className="mt-4 space-y-1 font-mono text-xs">
              {raw.processing_logs.map((log, index) => (
                <li key={`${log.step}-${index}`} className="flex justify-between gap-3">
                  <span className={log.status === "error" ? "text-destructive" : "text-foreground"}>
                    {log.status === "error" ? "✕" : "✓"} {log.step}
                    {log.detail && log.status === "error" ? ` — ${String(log.detail)}` : ""}
                  </span>
                  <span className="text-muted-foreground">{log.ms}ms</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4">
              <Degraded reason="No worker step log is stored for this inspection." />
            </div>
          )}
        </Panel>

        {/* 12 — RAW METADATA */}
        <Panel title="12 · Raw metadata" description="Source frame, pixel statistics and the untouched analysis JSON.">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Source frame</p>
              <div className="relative mt-3">
                {image_url ? (
                  <>
                    <img
                      src={image_url}
                      alt="Uploaded vehicle photograph submitted for verification"
                      className="w-full rounded-lg border border-border"
                    />
                    {bbox ? (
                      <span
                        className="pointer-events-none absolute rounded border-2 border-primary"
                        style={{
                          left: `${bbox[0] * 100}%`,
                          top: `${bbox[1] * 100}%`,
                          width: `${bbox[2] * 100}%`,
                          height: `${bbox[3] * 100}%`,
                        }}
                      />
                    ) : null}
                  </>
                ) : (
                  <Degraded reason="Signed image URL unavailable." />
                )}
              </div>
              <dl className="mt-4 space-y-1.5 font-mono text-xs">
                <Row
                  label="dimensions"
                  value={result?.image_width ? `${result.image_width}×${result.image_height}` : "—"}
                />
                <Row label="phash" value={result?.image_hash ?? "—"} />
                <Row label="exif" value={result ? (result.has_exif_metadata ? "present" : "absent") : "—"} />
                <Row
                  label="contrast"
                  value={raw.contrast ? `sd ${raw.contrast.contrast_stddev} · range ${raw.contrast.dynamic_range}` : "—"}
                />
                <Row
                  label="nearest hash distance"
                  value={raw.duplicate?.nearest_distance == null ? "n/a" : `${raw.duplicate.nearest_distance}/64`}
                />
              </dl>
            </div>
            <div className="rounded-2xl border border-border bg-card">
              <button
                onClick={() => setShowRaw((v) => !v)}
                className="flex w-full items-center justify-between p-5 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground"
              >
                Raw analysis JSON
                <ChevronDown className={`size-4 transition-transform ${showRaw ? "rotate-180" : ""}`} />
              </button>
              {showRaw ? (
                <pre className="max-h-96 overflow-auto border-t border-border p-5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(result?.raw_analysis_json ?? { note: "no analysis result stored" }, null, 2)}
                </pre>
              ) : null}
            </div>
          </div>
        </Panel>
      </div>
    </Shell>
  );
}

function Degraded({ reason }: { reason: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-secondary/20 p-4 text-sm text-muted-foreground">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>{reason}</span>
    </div>
  );
}

function StatusPill({ status }: { status: "pass" | "warn" | "fail" }) {
  const map = {
    pass: "border-success/40 bg-success/10 text-success",
    warn: "border-warning/40 bg-warning/10 text-warning",
    fail: "border-destructive/40 bg-destructive/10 text-destructive",
  } as const;
  return (
    <span className={cn("rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest", map[status])}>
      {status}
    </span>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums">{value}%</p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn("h-full rounded-full", value >= 70 ? "bg-success" : value >= 40 ? "bg-warning" : "bg-destructive")}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone?: "success" | "danger" | undefined;
  icon?: React.ReactNode | undefined;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {icon}
        {label}
      </p>
      <p
        className={cn(
          "mt-1 break-words text-sm font-medium",
          tone === "success" ? "text-success" : tone === "danger" ? "text-destructive" : "",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}


function GuardedDetail() {
  return (
    <RequireAuth>
      <DetailPage />
    </RequireAuth>
  );
}
