/**
 * The analysis worker ("process" half of the pipeline).
 *
 * QUEUE TRADE-OFF (documented, deliberate):
 * There is no broker here. A Postgres AFTER INSERT trigger calls pg_net.http_post
 * against /api/public/analyze-image, which returns 202 immediately and does the
 * work out-of-band. That gives us the two properties that actually matter for the
 * upload path — the client never waits for analysis, and processing runs in a
 * separate execution context from the request that created the row — without
 * standing up SQS/Redis. What it does NOT give us: durable redelivery, visibility
 * timeouts, backpressure, ordering, or a dead-letter queue. The `uploads` row IS
 * the queue message: status='pending' means "not yet claimed", 'processing' means
 * "claimed", retry_count is the delivery counter. Swapping in a real broker means
 * replacing enqueueAnalysis() and the trigger only; processUpload() below is
 * transport-agnostic and stays as-is.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeImage } from "./analysis/image.server";
import { readExif } from "./analysis/exif.server";
import {
  computeDifferenceHash,
  computeOverallConfidence,
  detectBlur,
  detectLowLight,
  detectScreenshot,
  detectTampering,
  findDuplicate,
  runVisionExtraction,
  type VisionExtraction,
  validateDimensions,
  validateIndianPlate,
  BLUR_VARIANCE_THRESHOLD,
  LOW_LIGHT_THRESHOLD,
  MIN_DIMENSION,
  HAMMING_DUPLICATE_THRESHOLD,
} from "./analysis/checks.server";
import {
  buildFindings,
  buildForensicChecks,
  buildFieldSightSummary,
  computeTrustScore,
  runConfidenceEngine,
  verdictFor,
} from "./analysis/report.server";
import { buildQualityScores, computeContrast, detectOverlayBand } from "./analysis/quality.server";
import { assessSyntheticRisk, EMPTY_AI_VISION_HINTS } from "./analysis/synthetic-risk.server";
import { decodeRto } from "./rto";

type Client = SupabaseClient<any, any, any>;

export type ProcessingLog = {
  step: string;
  status: "ok" | "skipped" | "error";
  ms: number;
  detail?: unknown;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Structured log line + persisted timeline event. Observability here is
 * deliberately two-channel: stdout for operators tailing the worker, and a
 * durable row so the UI can render an audit trail long after the logs rotate.
 */
async function recordEvent(
  supabase: Client,
  uploadId: string,
  event: string,
  message: string,
  durationMs?: number,
) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "AnalysisWorker",
      processingId: uploadId,
      event,
      duration_ms: durationMs ?? null,
      message,
    }),
  );
  const { error } = await supabase
    .from("processing_events")
    .insert({ upload_id: uploadId, event, message, duration_ms: durationMs ?? null });
  if (error) console.error(`[events:${uploadId}] could not persist ${event}: ${error.message}`);
}

export { recordEvent };

/** "enqueue" half — the only function that knows about the transport. */
export async function enqueueAnalysis(uploadId: string, origin: string): Promise<void> {
  const url = `${origin}/api/public/analyze-image`;
  console.log(`[enqueue] dispatching upload ${uploadId} -> ${url}`);
  // Fire-and-forget: we intentionally do not await the analysis result.
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload_id: uploadId }),
  }).catch((error) => console.error(`[enqueue] dispatch failed for ${uploadId}`, error));
}

/** "process" half — transport-agnostic. A BullMQ/SQS worker would call exactly this. */
export async function processUpload(supabase: Client, uploadId: string) {
  const logs: ProcessingLog[] = [];
  const startedAt = Date.now();
  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const t0 = Date.now();
    try {
      const result = await fn();
      logs.push({ step: name, status: "ok", ms: Date.now() - t0 });
      console.log(`[analyze:${uploadId}] ${name} ok in ${Date.now() - t0}ms`);
      return result;
    } catch (error) {
      logs.push({
        step: name,
        status: "error",
        ms: Date.now() - t0,
        detail: error instanceof Error ? error.message : String(error),
      });
      console.error(`[analyze:${uploadId}] ${name} failed`, error);
      throw error;
    }
  };

  const { data: upload, error: loadError } = await supabase
    .from("uploads")
    .select("*")
    .eq("id", uploadId)
    .maybeSingle();
  if (loadError) throw new Error(`Could not load upload row: ${loadError.message}`);
  if (!upload) throw new Error(`Upload ${uploadId} does not exist`);

  await supabase
    .from("uploads")
    .update({ status: "processing", failure_reason: null })
    .eq("id", uploadId);
  console.log(`[analyze:${uploadId}] status -> processing`);
  await recordEvent(supabase, uploadId, "PROCESSING_STARTED", "Worker claimed the job and began analysis.");

  try {
    const bytes = await step("download_from_storage", async () => {
      const { data, error } = await supabase.storage
        .from("vehicle-images")
        .download(upload.file_path as string);
      if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
      return new Uint8Array(await data.arrayBuffer());
    });

    const image = await step("decode_image", () =>
      decodeImage(bytes, upload.mime_type as string),
    );
    await recordEvent(supabase, uploadId, "IMAGE_DECODED", `Decoded ${upload.mime_type} into a raw pixel buffer.`);
    const exif = await step("read_exif", () => readExif(bytes));
    const dimensions = await step("check_dimensions", () => validateDimensions(image));
    const blur = await step("check_blur", () => detectBlur(image));
    const light = await step("check_brightness", () => detectLowLight(image));
    const hash = await step("compute_perceptual_hash", () => computeDifferenceHash(image));

    const duplicate = await step("check_duplicates", async () => {
      const { data, error } = await supabase
        .from("analysis_results")
        .select("upload_id, image_hash")
        .neq("upload_id", uploadId)
        .not("image_hash", "is", null)
        .limit(2000);
      if (error) throw new Error(`Hash lookup failed: ${error.message}`);
      return findDuplicate(hash, (data ?? []) as Array<{ upload_id: string; image_hash: string }>);
    });

    const screenshot = await step("check_screenshot", () =>
      detectScreenshot(image, exif, upload.mime_type as string),
    );
    const tamper = await step("check_tampering", () => detectTampering(image, exif));
    const contrast = await step("check_contrast", () => computeContrast(image));
    const overlay = await step("check_overlay_band", () => detectOverlayBand(image));
    await recordEvent(
      supabase,
      uploadId,
      "QUALITY_ANALYSIS_COMPLETED",
      "Sharpness, exposure, duplicate, screenshot, tamper and resolution checks completed.",
      Date.now() - startedAt,
    );

    // OCR is the only network-dependent check; a provider failure degrades the
    // result instead of failing the whole upload.
    let ocr: VisionExtraction = {
      raw_text: null,
      model_confidence: 0,
      plate_bbox: null,
      plate_visibility: 0,
      vehicle_visibility: 0,
      advertisement_coverage: 0,
      overlay_text_present: false,
      full_text: null,
      entities: [],
      note: "OCR not run",
      vehicle_present: false,
      vehicle_type: null,
      vehicle_confidence: 0,
      vehicle_bbox: null,
      vehicle_colour: null,
      ai_hints: { ...EMPTY_AI_VISION_HINTS },
    };
    let ocrStatus: "ok" | "failed" = "ok";
    let ocrError: string | null = null;
    const t0 = Date.now();
    try {
      const apiKey = process.env["LOVABLE_API_KEY"];
      if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");
      ocr = await runVisionExtraction(toBase64(bytes), upload.mime_type as string, apiKey);
      logs.push({ step: "ocr_plate", status: "ok", ms: Date.now() - t0, detail: ocr.raw_text });
    } catch (error) {
      ocrStatus = "failed";
      ocrError = error instanceof Error ? error.message : String(error);
      logs.push({
        step: "ocr_plate",
        status: "error",
        ms: Date.now() - t0,
        detail: `${ocrError} (non-fatal, continuing)`,
      });
      console.error(`[analyze:${uploadId}] ocr_plate degraded`, error);
    }
    const plate = validateIndianPlate(ocr.raw_text);
    await recordEvent(
      supabase,
      uploadId,
      "OCR_COMPLETED",
      ocr.raw_text
        ? `OCR extracted "${ocr.raw_text}" at ${Math.round(ocr.model_confidence * 100)}% model confidence.`
        : ocrStatus === "failed"
          ? `OCR stage failed (${ocrError}); remaining analyses continued without it.`
          : "OCR did not find a legible registration plate.",
      Date.now() - t0,
    );

    const overall = computeOverallConfidence([
      blur.blur_confidence,
      light.low_light_confidence,
      duplicate.is_duplicate ? duplicate.duplicate_confidence : 0,
      screenshot.screenshot_confidence,
      tamper.tamper_confidence,
      dimensions.resolution_confidence,
    ]);

    const checkInputs = {
      blur,
      light,
      duplicate,
      screenshot,
      tamper,
      dimensions,
      ocr,
      plate,
      thresholds: {
        blur: BLUR_VARIANCE_THRESHOLD,
        lowLight: LOW_LIGHT_THRESHOLD,
        minDimension: MIN_DIMENSION,
        hamming: HAMMING_DUPLICATE_THRESHOLD,
      },
    };
    const findings = buildFindings(checkInputs);
    const { trust_score: legacy_trust_score, penalties } = computeTrustScore(checkInputs);

    const vision = {
      plate_visibility: ocr.plate_visibility,
      vehicle_visibility: ocr.vehicle_visibility,
      advertisement_coverage: ocr.advertisement_coverage,
      overlay_text_present: ocr.overlay_text_present,
    };
    const quality = buildQualityScores(image, blur.blur_score, light.brightness_score, contrast, vision);
    const ai = await step("synthetic_risk_assessment", () =>
      assessSyntheticRisk({
        image,
        exif,
        mimeType: upload.mime_type as string,
        hints: ocr.ai_hints,
        screenshot_confidence: screenshot.screenshot_confidence,
        ocr_confidence: ocr.model_confidence,
        plate_present: Boolean(ocr.raw_text),
        sharpness_10: quality.find((q) => q.key === "sharpness")?.score ?? 0,
      }),
    );
    await recordEvent(
      supabase,
      uploadId,
      "AI_SYNTHESIS_ANALYSED",
      `Synthetic Image Risk Assessment: ${ai.verdict} — synthetic risk ${ai.synthetic_risk_score}/100, authenticity ${ai.authenticity_score}/100, assessment confidence ${ai.assessment_confidence}% across ${ai.checks.length} checks.`,
    );
    const forensics = buildForensicChecks({
      ...checkInputs,
      overlay,
      overlay_text_present: ocr.overlay_text_present,
      advertisement_coverage: ocr.advertisement_coverage,
      has_exif: exif.hasExif,
      ai,
    });
    const rto = decodeRto(plate.extracted_vehicle_number);
    const engine = runConfidenceEngine({
      ocr_confidence: ocr.model_confidence,
      plate_valid: plate.vehicle_number_valid_format,
      plate_present: !!plate.extracted_vehicle_number,
      sharpness_10: quality.find((q) => q.key === "sharpness")?.score ?? 0,
      brightness_10: quality.find((q) => q.key === "brightness")?.score ?? 0,
      plate_visibility: ocr.plate_visibility,
      vehicle_visibility: ocr.vehicle_visibility,
      has_exif: exif.hasExif,
      tamper_confidence: tamper.tamper_confidence,
      duplicate_confidence: duplicate.is_duplicate ? duplicate.duplicate_confidence : 0,
      advertisement_coverage: ocr.advertisement_coverage,
      screenshot_confidence: screenshot.screenshot_confidence,
      ai_confidence: ai.ai_confidence,
      authenticity_score: ai.authenticity_score,
    });
    const trust_score = engine.trust_score;
    const aiSummary = buildFieldSightSummary({
      plate: plate.extracted_vehicle_number,
      plateValid: plate.vehicle_number_valid_format,
      rtoState: rto?.state ?? null,
      rtoOffice: rto?.rto_office ?? null,
      quality,
      forensics,
      engine,
      advertisementCoverage: ocr.advertisement_coverage,
      ai,
    });
    const totalMs = Date.now() - startedAt;
    await recordEvent(
      supabase,
      uploadId,
      "CONFIDENCE_CALCULATED",
      `Weighted confidence engine produced ${trust_score}/100 (${engine.risk_level}) across ${engine.components.length} components` +
        (engine.ai_deduction ? `, after a ${engine.ai_deduction}-point synthetic-image deduction.` : "."),
    );

    const raw = {
      version: 2,
      analysed_at: new Date().toISOString(),
      total_ms: totalMs,
      findings,
      trust: {
        trust_score,
        base_trust_score: engine.base_trust_score,
        ai_deduction: engine.ai_deduction,
        risk_level: engine.risk_level,
        verdict: verdictFor(trust_score),
        components: engine.components,
        weight_total: engine.weight_total,
        legacy_penalty_model: { trust_score: legacy_trust_score, penalties },
      },
      quality_scores: quality,
      forensics,
      synthetic_risk: ai,
      ai_detection: ai, // legacy alias for reports rendered before the module rename
      rto,
      contrast,
      overlay,
      exif,
      blur,
      brightness: light,
      duplicate: { ...duplicate, image_hash: hash },
      screenshot,
      tamper,
      ocr: { ...ocr, normalised: plate.extracted_vehicle_number },
      ocr_status: { status: ocrStatus, error: ocrError, duration_ms: Date.now() - t0 },
      vehicle: {
        detected: ocr.vehicle_present,
        type: ocr.vehicle_type,
        confidence: ocr.vehicle_confidence,
        bbox: ocr.vehicle_bbox,
        colour: ocr.vehicle_colour,
        visibility: ocr.vehicle_visibility,
        status: ocrStatus === "failed" ? ("unavailable" as const) : ("ok" as const),
      },
      dimensions,
      disclaimers: [
        "All checks are heuristics, not forensic proof. Booleans are threshold crossings on the stored confidence values.",
        "OCR text is model-extracted and may be wrong even when the format validates.",
      ],
      processing_logs: logs,
    };

    const { error: writeError } = await supabase.from("analysis_results").upsert(
      {
        upload_id: uploadId,
        is_blurry: blur.is_blurry,
        blur_score: blur.blur_score,
        brightness_score: light.brightness_score,
        is_low_light: light.is_low_light,
        is_duplicate: duplicate.is_duplicate,
        duplicate_of_upload_id: duplicate.duplicate_of_upload_id,
        image_hash: hash,
        is_screenshot_or_rephoto: screenshot.is_screenshot_or_rephoto,
        screenshot_confidence: screenshot.screenshot_confidence,
        is_tampered_suspected: tamper.is_tampered_suspected,
        tamper_confidence: tamper.tamper_confidence,
        extracted_vehicle_number: plate.extracted_vehicle_number,
        vehicle_number_valid_format: plate.vehicle_number_valid_format,
        image_width: dimensions.image_width,
        image_height: dimensions.image_height,
        has_exif_metadata: exif.hasExif,
        overall_confidence: overall,
        ai_summary: aiSummary,
        trust_score,
        ai_generated_confidence: ai.ai_confidence,
        ai_verdict: ai.verdict,
        risk_band: engine.risk_level,
        processing_ms: totalMs,
        raw_analysis_json: raw,
      },
      { onConflict: "upload_id" },
    );
    if (writeError) throw new Error(`Result write failed: ${writeError.message}`);

    await supabase
      .from("uploads")
      .update({ status: "completed", failure_reason: null })
      .eq("id", uploadId);
    console.log(`[analyze:${uploadId}] completed in ${Date.now() - startedAt}ms`);
    await recordEvent(
      supabase,
      uploadId,
      "REPORT_GENERATED",
      `Inspection report generated. Trust score ${trust_score}/100 — ${verdictFor(trust_score)}.`,
      totalMs,
    );
    return { ok: true as const, upload_id: uploadId, overall_confidence: overall };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await supabase
      .from("uploads")
      .update({
        status: "failed",
        failure_reason: reason,
        retry_count: ((upload.retry_count as number) ?? 0) + 1,
      })
      .eq("id", uploadId);
    console.error(`[analyze:${uploadId}] FAILED: ${reason}`);
    await recordEvent(supabase, uploadId, "JOB_FAILED", reason, Date.now() - startedAt);
    return { ok: false as const, upload_id: uploadId, failure_reason: reason, logs };
  }
}