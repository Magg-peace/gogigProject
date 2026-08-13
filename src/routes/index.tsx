import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Copy,
  Eye,
  Fingerprint,
  Gauge,
  MapPin,
  ScanLine,
  ShieldAlert,
  Sun,
  UploadCloud,
  Workflow,
} from "lucide-react";
import { Shell } from "@/components/vehicle-check";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "FieldSight AI — Intelligent vehicle media verification" },
      {
        name: "description",
        content:
          "Verify vehicle photos with OCR, RTO decoding, forensic checks and weighted trust scoring — every verdict backed by explainable confidence.",
      },
      { property: "og:title", content: "FieldSight AI — Intelligent vehicle media verification" },
      {
        property: "og:description",
        content:
          "Vehicle image inspection you can defend in an audit: OCR, RTO intelligence, forensics, trust scoring and full observability.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HomePage,
});

const PIPELINE = [
  "Vehicle image",
  "Upload API",
  "Metadata storage",
  "Async job queue",
  "Worker",
  "OCR engine",
  "Image analysis engine",
  "Confidence engine",
  "Inspection report",
];

const CHECKS = [
  { icon: Eye, title: "Blur detection", body: "Resolution-normalised Laplacian variance, so a 12 MP photo and a 640px photo are scored on the same scale." },
  { icon: Sun, title: "Low-light detection", body: "Mean luma plus dark-pixel ratio; separates an underexposed frame from a legitimately dark scene." },
  { icon: Copy, title: "Duplicate detection", body: "64-bit perceptual difference hash with Hamming search across the corpus — catches re-uploads and crops." },
  { icon: ScanLine, title: "Screenshot / re-photo", body: "EXIF absence, device-resolution matches, PNG containers and flat UI chrome bands combine into one score." },
  { icon: ShieldAlert, title: "Tamper suspicion", body: "Error Level Analysis over 16px blocks, plus editor fingerprints in EXIF software tags." },
  { icon: Fingerprint, title: "Plate OCR & format", body: "Vision-model read of the registration plate, validated against the Indian plate grammar." },
  { icon: MapPin, title: "RTO intelligence", body: "Offline decode of state, RTO office, district and registration category straight from the plate grammar." },
  { icon: Gauge, title: "Confidence engine", body: "Ten weighted components — OCR 25%, plate validation 20%, sharpness 15% — produce a 0-100 trust score and a risk band." },
];

function HomePage() {
  return (
    <Shell>
      <section className="rounded-3xl border border-border bg-card/60 p-8 md:p-12">
        <p className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
          <Workflow className="size-3.5" /> Async media intelligence
        </p>
        <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
          Vehicle image inspection you can defend in an audit
        </h1>
        <p className="mt-5 max-w-2xl text-base text-muted-foreground md:text-lg">
          AI-powered vehicle verification using OCR, RTO decoding, forensic image analysis,
          confidence scoring and asynchronous processing. Upload returns instantly; the pipeline
          produces a weighted trust score, a written assessment and a full audit timeline.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/upload">
              <UploadCloud className="size-4" /> Start an inspection
            </Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link to="/dashboard">
              Open dashboard <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
        <dl className="mt-10 grid gap-6 border-t border-border pt-8 sm:grid-cols-3">
          {[
            ["13", "checks and score cards per image"],
            ["0-100", "weighted trust score"],
            ["Non-blocking", "upload never waits on analysis"],
          ].map(([value, label]) => (
            <div key={label}>
              <dt className="text-2xl font-semibold text-primary">{value}</dt>
              <dd className="mt-1 text-sm text-muted-foreground">{label}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-12 rounded-2xl border border-border bg-card p-6">
        <h2 className="text-xl font-semibold tracking-tight">Processing architecture</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Every image travels the same path. Each hop writes an audit event, so a stalled inspection
          is always attributable to a specific stage.
        </p>
        <ol className="mt-6 flex flex-wrap items-center gap-2">
          {PIPELINE.map((stage, index) => (
            <li key={stage} className="flex items-center gap-2">
              <span
                className="rounded-lg border border-border bg-secondary/40 px-3 py-2 font-mono text-xs animate-in fade-in slide-in-from-bottom-1"
                style={{ animationDelay: `${index * 90}ms`, animationDuration: "500ms", animationFillMode: "both" }}
              >
                {stage}
              </span>
              {index < PIPELINE.length - 1 ? (
                <ArrowRight className="size-3.5 text-muted-foreground" />
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-12">
        <h2 className="text-xl font-semibold tracking-tight">What every image is screened for</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Each check is a heuristic with a published threshold. None of them are presented as
          ground truth — the score is always shown next to the verdict.
        </p>
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {CHECKS.map(({ icon: Icon, title, body }) => (
            <article
              key={title}
              className="rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40"
            >
              <span className="grid size-9 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
                <Icon className="size-4" />
              </span>
              <h3 className="mt-4 font-medium">{title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-12 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-6">
          <Gauge className="size-5 text-primary" />
          <h2 className="mt-4 text-lg font-semibold">Explainable by construction</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Findings are generated from the measured numbers, so the written summary can never
            disagree with the metrics it describes. Raw analyser output is kept for every run.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <Workflow className="size-5 text-primary" />
          <h2 className="mt-4 text-lg font-semibold">Observable end to end</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Every lifecycle transition is written to a durable audit trail, exposed as a per-image
            timeline, live queue metrics and dependency health probes.
          </p>
        </div>
      </section>
    </Shell>
  );
}
