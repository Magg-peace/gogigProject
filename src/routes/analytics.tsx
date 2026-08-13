import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getAnalyticsFn } from "@/lib/metrics.functions";
import { MetricCard, Panel, Shell, Skeleton } from "@/components/vehicle-check";

export const Route = createFileRoute("/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — Inspection quality trends | FieldSight AI" },
      {
        name: "description",
        content:
          "Volume trends, issue distribution, trust score histograms and OCR success rates across every vehicle image processed by the pipeline.",
      },
      { property: "og:title", content: "FieldSight AI Analytics" },
      {
        property: "og:description",
        content: "Volume, issue distribution and trust score analytics for the inspection pipeline.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AnalyticsPage,
});

const ISSUE_LABELS: Record<string, string> = {
  blur: "Blurry",
  low_light: "Low light",
  duplicate: "Duplicate",
  screenshot: "Screenshot",
  tamper: "Tamper suspected",
  invalid_plate: "Plate unreadable",
  ai_generated: "Likely synthetic",
  ai_suspicious: "Synthetic — suspicious",
};

const axis = {
  stroke: "var(--muted-foreground)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

function ChartTooltip() {
  return (
    <Tooltip
      cursor={{ fill: "var(--secondary)", opacity: 0.4 }}
      contentStyle={{
        background: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        fontSize: 12,
      }}
      labelStyle={{ color: "var(--muted-foreground)" }}
    />
  );
}

function AnalyticsPage() {
  const getAnalytics = useServerFn(getAnalyticsFn);
  const { data, isLoading } = useQuery({
    queryKey: ["analytics"],
    queryFn: () => getAnalytics(),
    refetchInterval: 60_000,
  });

  const issues = data
    ? Object.entries(data.issues).map(([key, count]) => ({
        name: ISSUE_LABELS[key] ?? key,
        count,
      }))
    : [];

  return (
    <Shell
      eyebrow="Analytics"
      title="Inspection quality trends"
      subtitle="Aggregates over the processed corpus. Use these to tune thresholds — a check that never fires, or always fires, is not doing work."
    >
      {isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Images processed" value={data.totals.total} />
            <MetricCard
              label="Avg trust score"
              value={data.totals.avg_trust_score}
              hint="0-100, weighted by operational impact"
              tone={data.totals.avg_trust_score >= 70 ? "success" : "warning"}
            />
            <MetricCard
              label="Avg processing time"
              value={`${(data.totals.avg_processing_ms / 1000).toFixed(2)}s`}
              hint="download, decode, 7 checks, OCR"
            />
            <MetricCard
              label="OCR read rate"
              value={`${data.totals.ocr_success_rate}%`}
              hint="images yielding a plate string"
              tone="info"
            />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <MetricCard
              label="Likely synthetic uploads"
              value={data.totals.ai_generated}
              hint="synthetic risk above 70"
              tone={data.totals.ai_generated ? "danger" : "success"}
            />
            <MetricCard label="Duplicate submissions" value={data.totals.duplicates} tone={data.totals.duplicates ? "warning" : "success"} />
            <MetricCard label="Screenshot uploads" value={data.totals.screenshots} tone={data.totals.screenshots ? "warning" : "success"} />
            <MetricCard label="Tampering alerts" value={data.totals.tampering} tone={data.totals.tampering ? "danger" : "success"} />
            <MetricCard
              label="AI suspicious uploads"
              value={data.totals.ai_suspicious}
              hint="synthetic risk 31–70"
              tone={data.totals.ai_suspicious ? "warning" : "success"}
            />
            <MetricCard
              label="Authentic uploads"
              value={data.totals.ai_authentic}
              hint="synthetic risk 30 or below"
              tone="success"
            />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Panel title="Volume — last 7 days" description="Submissions per UTC day, failures overlaid.">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.volume_trend} margin={{ left: -20, right: 8, top: 8 }}>
                    <defs>
                      <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} {...axis} />
                    <YAxis allowDecimals={false} {...axis} />
                    <ChartTooltip />
                    <Area
                      type="monotone"
                      dataKey="count"
                      name="Submitted"
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      fill="url(#vol)"
                    />
                    <Area
                      type="monotone"
                      dataKey="failed"
                      name="Failed"
                      stroke="var(--chart-4)"
                      strokeWidth={2}
                      fill="transparent"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <Panel title="Trust score distribution" description="How the corpus splits across 20-point trust bands.">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.trust_distribution} margin={{ left: -20, right: 8, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" {...axis} />
                    <YAxis allowDecimals={false} {...axis} />
                    <ChartTooltip />
                    <Bar dataKey="count" name="Images" radius={[6, 6, 0, 0]}>
                      {data.trust_distribution.map((b, i) => (
                        <Cell
                          key={b.label}
                          fill={
                            i >= 4 ? "var(--chart-2)" : i >= 2 ? "var(--chart-3)" : "var(--chart-4)"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <Panel
            className="mt-6"
            title="Issue distribution"
            description="How often each check flags an image. A check firing on nearly everything usually means the threshold, not the corpus, is wrong."
          >
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={issues} layout="vertical" margin={{ left: 40, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} {...axis} />
                  <YAxis type="category" dataKey="name" width={110} {...axis} />
                  <ChartTooltip />
                  <Bar dataKey="count" name="Flagged" fill="var(--chart-1)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel
            className="mt-6"
            title="Risk band distribution"
            description="Final banding after the synthetic-image deduction is applied."
          >
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.risk_bands} margin={{ left: -20, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" {...axis} />
                  <YAxis allowDecimals={false} {...axis} />
                  <ChartTooltip />
                  <Bar dataKey="count" name="Inspections" radius={[6, 6, 0, 0]}>
                    {data.risk_bands.map((b, i) => (
                      <Cell
                        key={b.label}
                        fill={i <= 1 ? "var(--chart-2)" : i === 2 ? "var(--chart-3)" : "var(--chart-4)"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </>
      )}
    </Shell>
  );
}
