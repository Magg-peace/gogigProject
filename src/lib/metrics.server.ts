// Observability read-model: analytics aggregates, queue health, platform health,
// and per-inspection audit trails. Kept separate from uploads.server.ts so the
// write path and the monitoring path can evolve (and be cached) independently.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type QueueCounts = Record<"pending" | "processing" | "completed" | "failed", number>;

export async function getAnalytics() {
  const { data: uploads, error } = await supabaseAdmin
    .from("uploads")
    .select("id, status, created_at, retry_count")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const { data: results, error: rErr } = await supabaseAdmin
    .from("analysis_results")
    .select(
      "upload_id, is_blurry, is_low_light, is_duplicate, is_screenshot_or_rephoto, is_tampered_suspected, vehicle_number_valid_format, extracted_vehicle_number, trust_score, processing_ms, created_at, ai_generated_confidence, ai_verdict, risk_band",
    )
    .limit(2000);
  if (rErr) throw new Error(rErr.message);

  const rows = uploads ?? [];
  const res = results ?? [];

  const queue: QueueCounts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const u of rows) queue[(u.status as keyof QueueCounts) ?? "pending"]++;

  const durations = res.map((r) => r.processing_ms ?? 0).filter((n) => n > 0);
  const avgMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  const issues = {
    blur: res.filter((r) => r.is_blurry).length,
    low_light: res.filter((r) => r.is_low_light).length,
    duplicate: res.filter((r) => r.is_duplicate).length,
    screenshot: res.filter((r) => r.is_screenshot_or_rephoto).length,
    tamper: res.filter((r) => r.is_tampered_suspected).length,
    invalid_plate: res.filter((r) => !r.vehicle_number_valid_format).length,
    // Synthetic Image Risk Assessment bands: 0-30 authentic, 31-70 suspicious, 71-100 synthetic.
    ai_generated: res.filter((r) => Number(r.ai_generated_confidence ?? 0) > 0.7).length,
    ai_suspicious: res.filter((r) => {
      const c = Number(r.ai_generated_confidence ?? 0);
      return c > 0.3 && c <= 0.7;
    }).length,
  };
  const authentic = res.filter((r) => Number(r.ai_generated_confidence ?? 0) <= 0.3).length;

  const bands = ["Verified", "Low Risk", "Medium Risk", "High Risk", "Rejected"] as const;
  const risk_bands = bands.map((label) => ({
    label,
    count: res.filter((r) => (r.risk_band ?? "") === label).length,
  }));
  const rejected = res.filter((r) => r.risk_band === "Rejected").length;

  const ocrSuccess = res.length
    ? Math.round((res.filter((r) => !!r.extracted_vehicle_number).length / res.length) * 100)
    : 0;

  const trustScores = res.map((r) => r.trust_score).filter((n): n is number => typeof n === "number");
  const avgTrust = trustScores.length
    ? Math.round(trustScores.reduce((a, b) => a + b, 0) / trustScores.length)
    : 0;

  // Trust score histogram in 20-point buckets.
  const buckets = [0, 20, 40, 60, 80].map((lo) => ({
    label: `${lo}-${lo + 19}`,
    count: trustScores.filter((s) => s >= lo && s < lo + 20).length,
  }));
  if (buckets[4]) buckets[4].count = trustScores.filter((s) => s >= 80).length;

  // Volume trend over the last 7 days (UTC day buckets).
  const days: Array<{ day: string; count: number; failed: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    days.push({
      day: key,
      count: rows.filter((u) => (u.created_at as string).slice(0, 10) === key).length,
      failed: rows.filter(
        (u) => (u.created_at as string).slice(0, 10) === key && u.status === "failed",
      ).length,
    });
  }

  const total = rows.length;
  return {
    totals: {
      total,
      completed: queue.completed,
      failed: queue.failed,
      in_flight: queue.pending + queue.processing,
      success_rate: total ? Math.round((queue.completed / total) * 100) : 0,
      avg_processing_ms: avgMs,
      avg_trust_score: avgTrust,
      ocr_success_rate: ocrSuccess,
      retries: rows.reduce((a, u) => a + ((u.retry_count as number) ?? 0), 0),
      ai_generated: issues.ai_generated,
      ai_suspicious: issues.ai_suspicious,
      ai_authentic: authentic,
      duplicates: issues.duplicate,
      screenshots: issues.screenshot,
      tampering: issues.tamper,
      rejected,
    },
    queue,
    issues,
    trust_distribution: buckets,
    risk_bands,
    volume_trend: days,
  };
}

export async function getTimeline(uploadId: string) {
  const { data, error } = await supabaseAdmin
    .from("processing_events")
    .select("id, event, message, duration_ms, created_at")
    .eq("upload_id", uploadId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Dependency probes. Each is measured independently so a partial outage is visible. */
export async function getHealth() {
  const probe = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    try {
      await fn();
      return { name, status: "healthy" as const, latency_ms: Date.now() - t0, detail: null as string | null };
    } catch (error) {
      return {
        name,
        status: "degraded" as const,
        latency_ms: Date.now() - t0,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const components = await Promise.all([
    probe("Database", async () => {
      const { error } = await supabaseAdmin.from("uploads").select("id").limit(1);
      if (error) throw new Error(error.message);
    }),
    probe("Object Storage", async () => {
      const { error } = await supabaseAdmin.storage.from("vehicle-images").list("", { limit: 1 });
      if (error) throw new Error(error.message);
    }),
    probe("Analysis Worker", async () => {
      // Stuck-job probe: anything claimed for >5 minutes means a worker died mid-job.
      const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data, error } = await supabaseAdmin
        .from("uploads")
        .select("id")
        .eq("status", "processing")
        .lt("updated_at", cutoff)
        .limit(1);
      if (error) throw new Error(error.message);
      if (data?.length) throw new Error("A job has been in `processing` for over 5 minutes.");
    }),
    probe("OCR Provider", async () => {
      if (!process.env["LOVABLE_API_KEY"]) throw new Error("OCR credentials are not configured.");
    }),
  ]);

  const { data: pending } = await supabaseAdmin
    .from("uploads")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "processing"]);
  void pending;

  return {
    status: components.every((c) => c.status === "healthy") ? "healthy" : "degraded",
    checked_at: new Date().toISOString(),
    components,
  };
}

/**
 * Queue operations read-model: retries and the dead-letter set.
 *
 * The `uploads` row is the queue record (see pipeline.server.ts). A job is
 * considered dead-lettered once it has failed and burned its delivery budget —
 * it will not be re-driven automatically and needs an operator decision.
 */
export const MAX_DELIVERY_ATTEMPTS = 3;

export type QueueJob = {
  id: string;
  original_filename: string;
  status: string;
  retry_count: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

export async function getQueueOps() {
  const { data, error } = await supabaseAdmin
    .from("uploads")
    .select("id, original_filename, status, retry_count, failure_reason, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as QueueJob[];

  const failed = rows.filter((r) => r.status === "failed");
  const deadLetter = failed.filter((r) => (r.retry_count ?? 0) >= MAX_DELIVERY_ATTEMPTS);
  const retryable = failed.filter((r) => (r.retry_count ?? 0) < MAX_DELIVERY_ATTEMPTS);
  const stuckCutoff = Date.now() - 5 * 60_000;
  const stuck = rows.filter(
    (r) => r.status === "processing" && new Date(r.updated_at).getTime() < stuckCutoff,
  );

  // Failure reasons collapsed into buckets so an operator sees the pattern, not 40 lines.
  const reasons = new Map<string, number>();
  for (const r of failed) {
    const key = (r.failure_reason ?? "Unknown error").slice(0, 120);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }

  const attempted = rows.filter((r) => (r.retry_count ?? 0) > 0);
  const totalRetries = rows.reduce((a, r) => a + (r.retry_count ?? 0), 0);
  const recovered = attempted.filter((r) => r.status === "completed").length;

  return {
    max_attempts: MAX_DELIVERY_ATTEMPTS,
    counts: {
      total: rows.length,
      failed: failed.length,
      dead_letter: deadLetter.length,
      retryable: retryable.length,
      stuck: stuck.length,
      total_retries: totalRetries,
      retried_jobs: attempted.length,
      recovered_after_retry: recovered,
      retry_success_rate: attempted.length ? Math.round((recovered / attempted.length) * 100) : 0,
    },
    dead_letter: deadLetter.slice(0, 25),
    retryable: retryable.slice(0, 25),
    stuck: stuck.slice(0, 25),
    failure_reasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
  };
}

/** Re-drive every failed job that still has delivery budget left. */
export async function replayFailedJobs(origin: string) {
  const { retryUpload } = await import("./uploads.server");
  const ops = await getQueueOps();
  const targets = [...ops.retryable, ...ops.stuck];
  let replayed = 0;
  for (const job of targets) {
    try {
      if (job.status === "processing") {
        // Reclaim a job abandoned by a dead worker before re-driving it.
        await supabaseAdmin
          .from("uploads")
          .update({ status: "failed", failure_reason: "Worker timed out; job reclaimed." })
          .eq("id", job.id);
      }
      await retryUpload(job.id, origin);
      replayed++;
    } catch (error) {
      console.error(`[queue] replay failed for ${job.id}:`, error);
    }
  }
  return { replayed, skipped_dead_letter: ops.counts.dead_letter };
}
