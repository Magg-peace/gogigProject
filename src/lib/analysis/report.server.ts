/**
 * Confidence scoring + explainability layer.
 *
 * Every check in checks.server.ts returns a boolean plus a 0..1 confidence.
 * That is the right shape for storage, but it is NOT the right shape for a
 * human reviewer: a bare `is_blurry: true` gives no way to judge whether the
 * call was marginal or overwhelming. This module converts each raw check into
 * a Finding — result, 0..100 confidence, plain-English reasoning, and the raw
 * metrics the confidence was derived from — and then synthesises a weighted
 * Trust Score plus a written assessment.
 */
import type { SyntheticRiskResult } from "./synthetic-risk.server";

export type Finding = {
  key: string;
  label: string;
  detected: boolean;
  /** 0..100 — how sure we are of `detected`, NOT how bad the image is. */
  confidence: number;
  reasoning: string;
  metrics: Record<string, number | string | boolean | null>;
  /** true when `detected` is a good thing (OCR success, valid plate). */
  positive?: boolean;
};

const pct = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);

/**
 * Weighting strategy for the Trust Score (0..100).
 *
 * Each check contributes a penalty = weight * confidence-that-something-is-wrong.
 * Weights encode operational impact rather than statistical certainty:
 *  - tampering and duplicates are fraud signals -> heaviest
 *  - blur and resolution directly break downstream OCR -> heavy
 *  - screenshots are usually policy violations -> medium
 *  - low light is often recoverable -> light
 * A missing/invalid plate is handled separately as a capped penalty because a
 * plate can legitimately be absent from a valid photo (e.g. an interior shot).
 */
export const TRUST_WEIGHTS = {
  tamper: 30,
  duplicate: 25,
  blur: 20,
  resolution: 12,
  screenshot: 15,
  low_light: 10,
  plate: 15,
} as const;

export type CheckInputs = {
  blur: { blur_score: number; is_blurry: boolean; blur_confidence: number };
  light: {
    brightness_score: number;
    dark_pixel_ratio: number;
    is_low_light: boolean;
    low_light_confidence: number;
  };
  duplicate: {
    is_duplicate: boolean;
    duplicate_of_upload_id: string | null;
    nearest_distance: number | null;
    duplicate_confidence: number;
  };
  screenshot: {
    is_screenshot_or_rephoto: boolean;
    screenshot_confidence: number;
    screenshot_signals: string[];
  };
  tamper: { is_tampered_suspected: boolean; tamper_confidence: number; tamper_signals: string[] };
  dimensions: {
    image_width: number;
    image_height: number;
    insufficient_resolution: boolean;
    resolution_confidence: number;
  };
  ocr: { raw_text: string | null; model_confidence: number };
  plate: { extracted_vehicle_number: string | null; vehicle_number_valid_format: boolean };
  thresholds: { blur: number; lowLight: number; minDimension: number; hamming: number };
};

export function buildFindings(i: CheckInputs): Finding[] {
  const f: Finding[] = [];

  f.push({
    key: "blur",
    label: "Image Sharpness Analysis",
    detected: i.blur.is_blurry,
    confidence: i.blur.is_blurry
      ? pct(i.blur.blur_confidence)
      : pct(Math.min(1, (i.blur.blur_score - i.thresholds.blur) / i.thresholds.blur)),
    reasoning: i.blur.is_blurry
      ? `Laplacian edge variance is ${i.blur.blur_score}, below the sharpness threshold of ${i.thresholds.blur}. Confidence scales with how far below the threshold the image sits.`
      : `Laplacian edge variance is ${i.blur.blur_score}, above the ${i.thresholds.blur} threshold. Edge detail is intact.`,
    metrics: {
      laplacian_variance: i.blur.blur_score,
      threshold: i.thresholds.blur,
    },
  });

  f.push({
    key: "low_light",
    label: "Exposure Analysis",
    detected: i.light.is_low_light,
    confidence: i.light.is_low_light
      ? pct(i.light.low_light_confidence)
      : pct(Math.min(1, (i.light.brightness_score - i.thresholds.lowLight) / i.thresholds.lowLight)),
    reasoning: i.light.is_low_light
      ? `Mean luma is ${i.light.brightness_score} (threshold ${i.thresholds.lowLight}) with ${(i.light.dark_pixel_ratio * 100).toFixed(1)}% of pixels near black. Confidence blends both signals.`
      : `Mean luma is ${i.light.brightness_score}, comfortably above the ${i.thresholds.lowLight} low-light threshold.`,
    metrics: {
      brightness_score: i.light.brightness_score,
      dark_pixel_ratio: i.light.dark_pixel_ratio,
      threshold: i.thresholds.lowLight,
    },
  });

  f.push({
    key: "ocr",
    label: "Registration Extraction",
    detected: !!i.ocr.raw_text,
    positive: true,
    confidence: pct(i.ocr.model_confidence),
    reasoning: i.ocr.raw_text
      ? `Vision OCR returned "${i.ocr.raw_text}" with model-reported confidence ${pct(i.ocr.model_confidence)}%. OCR output is probabilistic and should be treated as a suggestion.`
      : "No legible registration plate was found in the image.",
    metrics: {
      extracted_text: i.ocr.raw_text,
      normalised: i.plate.extracted_vehicle_number,
      model_confidence: pct(i.ocr.model_confidence),
    },
  });

  const plateConf = i.plate.extracted_vehicle_number
    ? i.plate.vehicle_number_valid_format
      ? Math.round(60 + pct(i.ocr.model_confidence) * 0.4)
      : Math.round(70 + pct(i.ocr.model_confidence) * 0.3)
    : 0;
  f.push({
    key: "plate",
    label: "Registration Validation",
    detected: i.plate.vehicle_number_valid_format,
    positive: true,
    confidence: plateConf,
    reasoning: !i.plate.extracted_vehicle_number
      ? "No registration string was available to validate."
      : i.plate.vehicle_number_valid_format
        ? `"${i.plate.extracted_vehicle_number}" matches the Indian registration pattern (SS RR LL NNNN). Format validity is deterministic; the confidence shown reflects the OCR read it depends on.`
        : `"${i.plate.extracted_vehicle_number}" does not match the Indian registration pattern. Either the plate is non-standard or the OCR read is wrong.`,
    metrics: {
      value: i.plate.extracted_vehicle_number,
      format_matched: i.plate.vehicle_number_valid_format,
    },
  });

  f.push({
    key: "duplicate",
    label: "Duplicate Submission Check",
    detected: i.duplicate.is_duplicate,
    confidence: i.duplicate.is_duplicate
      ? pct(i.duplicate.duplicate_confidence)
      : pct(1 - i.duplicate.duplicate_confidence),
    reasoning:
      i.duplicate.nearest_distance === null
        ? "No previously analysed images to compare against — this is the first submission in the corpus."
        : i.duplicate.is_duplicate
          ? `Nearest perceptual hash differs by only ${i.duplicate.nearest_distance}/64 bits (threshold ${i.thresholds.hamming}), indicating a re-submission of an already-seen image.`
          : `Closest stored image differs by ${i.duplicate.nearest_distance}/64 hash bits, well beyond the ${i.thresholds.hamming}-bit duplicate threshold.`,
    metrics: {
      hamming_distance: i.duplicate.nearest_distance,
      similarity: i.duplicate.nearest_distance === null ? null : Number((1 - i.duplicate.nearest_distance / 64).toFixed(3)),
      matched_upload_id: i.duplicate.duplicate_of_upload_id,
    },
  });

  f.push({
    key: "screenshot",
    label: "Screenshot / Photo-of-Photo Check",
    detected: i.screenshot.is_screenshot_or_rephoto,
    confidence: i.screenshot.is_screenshot_or_rephoto
      ? pct(i.screenshot.screenshot_confidence)
      : pct(1 - i.screenshot.screenshot_confidence),
    reasoning: i.screenshot.screenshot_signals.length
      ? `Heuristics triggered: ${i.screenshot.screenshot_signals.join("; ")}. Each signal adds a fixed weight; the sum is the confidence.`
      : "No screenshot heuristics triggered — EXIF, dimensions and container all look like direct camera capture.",
    metrics: {
      signals_triggered: i.screenshot.screenshot_signals.length,
    },
  });

  f.push({
    key: "tamper",
    label: "Tamper Suspicion (ELA)",
    detected: i.tamper.is_tampered_suspected,
    confidence: i.tamper.is_tampered_suspected
      ? pct(i.tamper.tamper_confidence)
      : pct(1 - i.tamper.tamper_confidence),
    reasoning: i.tamper.tamper_signals.length
      ? `Signals: ${i.tamper.tamper_signals.join("; ")}. Error Level Analysis is suggestive, never conclusive.`
      : "Recompression error is uniform across the frame and no editor metadata is present.",
    metrics: { signals_triggered: i.tamper.tamper_signals.length },
  });

  f.push({
    key: "resolution",
    label: "Resolution & Metadata",
    detected: i.dimensions.insufficient_resolution,
    confidence: i.dimensions.insufficient_resolution
      ? pct(i.dimensions.resolution_confidence)
      : 100,
    reasoning: i.dimensions.insufficient_resolution
      ? `Smallest side is ${Math.min(i.dimensions.image_width, i.dimensions.image_height)}px, below the ${i.thresholds.minDimension}px minimum needed for reliable plate reading.`
      : `${i.dimensions.image_width}x${i.dimensions.image_height} exceeds the ${i.thresholds.minDimension}px minimum on both axes.`,
    metrics: {
      width: i.dimensions.image_width,
      height: i.dimensions.image_height,
      min_required: i.thresholds.minDimension,
    },
  });

  return f;
}

export function computeTrustScore(i: CheckInputs): { trust_score: number; penalties: Record<string, number> } {
  const p: Record<string, number> = {
    tamper: TRUST_WEIGHTS.tamper * i.tamper.tamper_confidence,
    duplicate: TRUST_WEIGHTS.duplicate * (i.duplicate.is_duplicate ? i.duplicate.duplicate_confidence : 0),
    blur: TRUST_WEIGHTS.blur * i.blur.blur_confidence,
    resolution: TRUST_WEIGHTS.resolution * i.dimensions.resolution_confidence,
    screenshot: TRUST_WEIGHTS.screenshot * i.screenshot.screenshot_confidence,
    low_light: TRUST_WEIGHTS.low_light * i.light.low_light_confidence,
    plate: i.plate.vehicle_number_valid_format
      ? 0
      : i.plate.extracted_vehicle_number
        ? TRUST_WEIGHTS.plate * 0.6
        : TRUST_WEIGHTS.plate,
  };
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  return {
    trust_score: Math.max(0, Math.min(100, Math.round(100 - total))),
    penalties: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Number(v.toFixed(1))])),
  };
}

export function verdictFor(score: number): string {
  if (score >= 85) return "High confidence — accept";
  if (score >= 65) return "Acceptable for verification";
  if (score >= 45) return "Accept with caution — retake recommended";
  return "Reject — resubmission required";
}

/**
 * Deterministic natural-language assessment. Written from the findings rather
 * than by a second LLM call: the summary must never contradict the numbers it
 * is describing, and it must be reproducible for auditing.
 */
export function buildSummary(findings: Finding[], trustScore: number): string {
  const concerns = findings.filter((f) => !f.positive && f.detected);
  const positives = findings.filter((f) => f.positive && f.detected);
  const lines: string[] = [];

  const ocr = findings.find((f) => f.key === "ocr");
  const plate = findings.find((f) => f.key === "plate");
  if (ocr?.detected) {
    lines.push(
      `Registration "${ocr.metrics["normalised"] ?? ocr.metrics["extracted_text"]}" was extracted at ${ocr.confidence}% OCR confidence` +
        (plate?.detected
          ? " and matches the Indian registration format."
          : ", but it does not match the Indian registration format and should be confirmed manually."),
    );
  } else {
    lines.push("No readable registration plate was found in this image.");
  }

  if (concerns.length === 0) {
    lines.push("No quality or authenticity concerns were raised by the analysis suite.");
  } else {
    const worded = concerns
      .sort((a, b) => b.confidence - a.confidence)
      .map((c) => `${c.label.toLowerCase().replace(/ analysis| check.*| \(ela\)/g, "")} (${c.confidence}% confidence)`);
    lines.push(`Concerns detected: ${worded.join(", ")}.`);
  }

  if (positives.length && concerns.length) {
    lines.push("Positive and negative signals are both present, so the trust score reflects a weighted trade-off rather than a single verdict.");
  }

  lines.push(`Overall trust score is ${trustScore}/100 — ${verdictFor(trustScore).toLowerCase()}.`);
  return lines.join(" ");
}

/* ===================================================================== */
/* FieldSight confidence engine v2                                        */
/* ===================================================================== */

/**
 * Ten weighted components. The raw weights are the product specification's and
 * sum to 110, so they are normalised to a 0..100 scale — the ratio between
 * components is what encodes operational priority, not the absolute total.
 * Every component contributes weight * (0..1 quality of that dimension), so the
 * trust score is a weighted average of positives rather than a penalty pile.
 */
export const CONFIDENCE_WEIGHTS = {
  ocr_accuracy: 25,
  plate_validation: 20,
  ai_authenticity: 15,
  sharpness: 15,
  brightness: 10,
  plate_visibility: 10,
  vehicle_visibility: 10,
  metadata_integrity: 5,
  duplicate_detection: 5,
  advertisement_dominance: 5,
  screenshot_detection: 5,
} as const;

export type ConfidenceComponent = {
  key: keyof typeof CONFIDENCE_WEIGHTS;
  label: string;
  weight: number;
  /** 0..1 */
  score: number;
  /** weight * score, on the normalised 0..100 scale */
  contribution: number;
  basis: string;
};

export type ConfidenceEngineResult = {
  trust_score: number;
  /** Base score before the synthetic-image deduction. */
  base_trust_score: number;
  ai_deduction: number;
  risk_level: "Verified" | "Low Risk" | "Medium Risk" | "High Risk" | "Rejected";
  components: ConfidenceComponent[];
  weight_total: number;
  ai_confidence: number;
};

export type EngineInputs = {
  ocr_confidence: number; // 0..1
  plate_valid: boolean;
  plate_present: boolean;
  sharpness_10: number;
  brightness_10: number;
  plate_visibility: number; // 0..1
  vehicle_visibility: number; // 0..1
  has_exif: boolean;
  tamper_confidence: number; // 0..1
  duplicate_confidence: number; // 0..1 (0 when not a duplicate)
  advertisement_coverage: number; // 0..1
  screenshot_confidence: number; // 0..1
  /** 0..1 synthetic risk from the Synthetic Image Risk Assessment module. */
  ai_confidence?: number;
  /** 0..100 authenticity score (100 - synthetic risk). */
  authenticity_score?: number;
};

const c01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export function runConfidenceEngine(i: EngineInputs): ConfidenceEngineResult {
  const total = Object.values(CONFIDENCE_WEIGHTS).reduce((a, b) => a + b, 0);
  const norm = 100 / total;

  const raw: Array<[keyof typeof CONFIDENCE_WEIGHTS, string, number, string]> = [
    [
      "ocr_accuracy",
      "OCR accuracy",
      c01(i.ocr_confidence),
      `Model-reported confidence for the registration read (${Math.round(c01(i.ocr_confidence) * 100)}%).`,
    ],
    [
      "plate_validation",
      "Plate validation",
      i.plate_valid ? 1 : i.plate_present ? 0.35 : 0,
      i.plate_valid
        ? "Registration matches the MoRTH / Indian plate grammar."
        : i.plate_present
          ? "A string was read but it fails the Indian plate grammar — partial credit only."
          : "No registration string was available to validate.",
    ],
    [
      "ai_authenticity",
      "AI authenticity",
      c01((i.authenticity_score ?? (1 - c01(i.ai_confidence ?? 0)) * 100) / 100),
      `Synthetic Image Risk Assessment scored authenticity at ${Math.round(i.authenticity_score ?? (1 - c01(i.ai_confidence ?? 0)) * 100)}/100 (synthetic risk ${Math.round(c01(i.ai_confidence ?? 0) * 100)}/100).`,
    ],
    ["sharpness", "Sharpness", c01(i.sharpness_10 / 10), `Sharpness score card at ${i.sharpness_10}/10.`],
    ["brightness", "Brightness", c01(i.brightness_10 / 10), `Exposure score card at ${i.brightness_10}/10.`],
    [
      "plate_visibility",
      "Plate visibility",
      c01(i.plate_visibility),
      "How legibly the plate region occupies the frame.",
    ],
    [
      "vehicle_visibility",
      "Vehicle visibility",
      c01(i.vehicle_visibility),
      "How much of the vehicle body is unobstructed and in frame.",
    ],
    [
      "metadata_integrity",
      "Metadata integrity",
      c01((i.has_exif ? 0.6 : 0.2) + (1 - c01(i.tamper_confidence)) * 0.4),
      i.has_exif
        ? "EXIF block present; remainder of the score is the inverse of the tamper (ELA) confidence."
        : "No EXIF block — capture provenance cannot be corroborated; remainder from tamper analysis.",
    ],
    [
      "duplicate_detection",
      "Duplicate detection",
      1 - c01(i.duplicate_confidence),
      "Inverse of the perceptual-hash duplicate confidence against the stored corpus.",
    ],
    [
      "advertisement_dominance",
      "Advertisement dominance",
      1 - c01(i.advertisement_coverage),
      `Promotional / branding content covers roughly ${Math.round(c01(i.advertisement_coverage) * 100)}% of the frame.`,
    ],
    [
      "screenshot_detection",
      "Screenshot detection",
      1 - c01(i.screenshot_confidence),
      "Inverse of the screenshot / photo-of-photo heuristic confidence.",
    ],
  ];

  const components: ConfidenceComponent[] = raw.map(([key, label, score, basis]) => ({
    key,
    label,
    weight: CONFIDENCE_WEIGHTS[key],
    score: Number(score.toFixed(3)),
    contribution: Number((CONFIDENCE_WEIGHTS[key] * score * norm).toFixed(2)),
    basis,
  }));

  const base = Math.max(
    0,
    Math.min(100, Math.round(components.reduce((a, c) => a + c.contribution, 0))),
  );
  /**
   * Trust Score v2 — synthetic-risk override.
   * A credible AI-generation signal is not just another weighted component: a
   * fully synthetic frame can score perfectly on sharpness, exposure and OCR.
   * It is therefore applied as a hard deduction on top of the weighted average,
   * and above 0.85 it forces the risk band regardless of the numeric score.
   */
  const ai = c01(i.ai_confidence ?? 0);
  const aiDeduction = ai > 0.85 ? 40 : ai > 0.7 ? 25 : 0;
  const trust = Math.max(0, Math.min(100, base - aiDeduction));
  const risk: ConfidenceEngineResult["risk_level"] =
    ai > 0.95
      ? "High Risk"
      : ai > 0.85
        ? "High Risk"
        : trust >= 90
          ? "Verified"
          : trust >= 70
            ? "Low Risk"
            : trust >= 50
              ? "Medium Risk"
              : "High Risk";
  return {
    trust_score: trust,
    base_trust_score: base,
    ai_deduction: aiDeduction,
    risk_level: risk,
    components,
    weight_total: total,
    ai_confidence: Number(ai.toFixed(3)),
  };
}

/* --------------------------------------------------------------------- */
/* Forensic check cards                                                    */
/* --------------------------------------------------------------------- */

export type ForensicCheck = {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  /** 0..100 */
  confidence: number;
  explanation: string;
  evidence: string;
  recommendation: string;
};

export type ForensicInputs = CheckInputs & {
  overlay: { overlay_band_detected: boolean; overlay_edge: string | null; overlay_band_ratio: number };
  overlay_text_present: boolean;
  advertisement_coverage: number;
  has_exif: boolean;
  ai: SyntheticRiskResult;
};

export function buildForensicChecks(i: ForensicInputs): ForensicCheck[] {
  const s = (bad: boolean, marginal = false): ForensicCheck["status"] =>
    bad ? "fail" : marginal ? "warn" : "pass";

  const overlayDetected = i.overlay.overlay_band_detected || i.overlay_text_present;
  const adCoverage = Math.max(0, Math.min(1, i.advertisement_coverage));

  return [
    {
      key: "blur",
      label: "Blur detection",
      status: s(i.blur.is_blurry, i.blur.blur_score < i.thresholds.blur * 1.5),
      confidence: pct(i.blur.is_blurry ? i.blur.blur_confidence : 1 - i.blur.blur_confidence),
      explanation:
        "Variance of a 4-neighbour Laplacian response on a 512px-normalised grayscale copy; low variance means few sharp edges.",
      evidence: `Laplacian variance ${i.blur.blur_score} against a ${i.thresholds.blur} floor.`,
      recommendation: i.blur.is_blurry
        ? "Request a retake with the camera stabilised and the plate in focus."
        : "No action — edge detail is sufficient for plate reading.",
    },
    {
      key: "low_light",
      label: "Low light detection",
      status: s(i.light.is_low_light, i.light.brightness_score < i.thresholds.lowLight * 1.4),
      confidence: pct(i.light.is_low_light ? i.light.low_light_confidence : 1 - i.light.low_light_confidence),
      explanation: "Mean luma across the frame combined with the fraction of near-black pixels.",
      evidence: `Mean luma ${i.light.brightness_score}/255, ${(i.light.dark_pixel_ratio * 100).toFixed(1)}% of pixels below 40.`,
      recommendation: i.light.is_low_light
        ? "Recapture in daylight or with flash; underexposure suppresses plate contrast."
        : "No action — exposure is within the operating range.",
    },
    {
      key: "duplicate",
      label: "Duplicate detection",
      status: s(i.duplicate.is_duplicate, (i.duplicate.nearest_distance ?? 64) <= i.thresholds.hamming * 2),
      confidence: pct(i.duplicate.is_duplicate ? i.duplicate.duplicate_confidence : 1 - i.duplicate.duplicate_confidence),
      explanation: "64-bit difference hash compared by Hamming distance against every previously analysed image.",
      evidence:
        i.duplicate.nearest_distance === null
          ? "No prior images in the corpus to compare against."
          : `Nearest stored image differs by ${i.duplicate.nearest_distance}/64 bits (threshold ${i.thresholds.hamming}).`,
      recommendation: i.duplicate.is_duplicate
        ? "Treat as a re-submission; verify the field agent did not reuse an earlier capture."
        : "No action — this image is not a re-submission of a known frame.",
    },
    {
      key: "screenshot",
      label: "Screenshot detection",
      status: s(i.screenshot.is_screenshot_or_rephoto, i.screenshot.screenshot_confidence >= 0.3),
      confidence: pct(
        i.screenshot.is_screenshot_or_rephoto
          ? i.screenshot.screenshot_confidence
          : 1 - i.screenshot.screenshot_confidence,
      ),
      explanation: "EXIF absence, device-screen dimension matches, PNG container and flat UI chrome bands.",
      evidence: i.screenshot.screenshot_signals.length
        ? i.screenshot.screenshot_signals.join("; ")
        : "No screenshot signals triggered.",
      recommendation: i.screenshot.is_screenshot_or_rephoto
        ? "Require an original camera capture; screenshots break the chain of custody."
        : "No action — capture is consistent with a direct photo.",
    },
    {
      key: "rephoto",
      label: "Photo-of-photo detection",
      status: s(
        i.screenshot.is_screenshot_or_rephoto && i.tamper.is_tampered_suspected,
        i.screenshot.screenshot_confidence >= 0.35 && !i.dimensions.insufficient_resolution === false,
      ),
      confidence: pct(Math.max(0, i.screenshot.screenshot_confidence * 0.6 + i.tamper.tamper_confidence * 0.4)),
      explanation:
        "Re-photographing a printed or on-screen image leaves both screenshot-like metadata gaps and recompression artefacts; the two signals are combined.",
      evidence: `Screenshot confidence ${pct(i.screenshot.screenshot_confidence)}%, recompression confidence ${pct(i.tamper.tamper_confidence)}%.`,
      recommendation:
        i.screenshot.screenshot_confidence > 0.5
          ? "Ask the agent to photograph the vehicle directly rather than a displayed image."
          : "No action — no combined re-photography signature.",
    },
    {
      key: "overlay",
      label: "Metadata overlay detection",
      status: overlayDetected ? "warn" : "pass",
      confidence: pct(overlayDetected ? Math.max(0.6, i.overlay.overlay_band_ratio * 4) : 0.85),
      explanation:
        "Field apps burn GPS/timestamp banners into the frame. A dark, low-variance horizontal band at an edge plus model-read overlay text indicates a stamped capture.",
      evidence: i.overlay.overlay_band_detected
        ? `Flat dark band covering ${(i.overlay.overlay_band_ratio * 100).toFixed(1)}% of frame height at the ${i.overlay.overlay_edge} edge.`
        : i.overlay_text_present
          ? "Vision model read burned-in overlay text but no distinct banner band was measured."
          : "No overlay banner or burned-in stamp text detected.",
      recommendation: overlayDetected
        ? "Acceptable for GPS-camera workflows; confirm the stamp does not cover the plate."
        : "No action.",
    },
    {
      key: "advertisement",
      label: "Advertisement dominance",
      status: adCoverage >= 0.5 ? "fail" : adCoverage >= 0.2 ? "warn" : "pass",
      confidence: pct(adCoverage > 0 ? 0.6 + adCoverage * 0.4 : 0.8),
      explanation:
        "Promotional wraps and branding can crowd out the registration area and are a common source of false OCR reads.",
      evidence: `Estimated ${Math.round(adCoverage * 100)}% of the frame is advertising or branding content.`,
      recommendation:
        adCoverage >= 0.5
          ? "Recapture framing tightly on the vehicle and plate."
          : "No action — branding does not dominate the frame.",
    },
    {
      key: "tamper",
      label: "Tampering risk",
      status: s(i.tamper.is_tampered_suspected, i.tamper.tamper_confidence >= 0.25),
      confidence: pct(i.tamper.is_tampered_suspected ? i.tamper.tamper_confidence : 1 - i.tamper.tamper_confidence),
      explanation:
        "Error Level Analysis re-encodes the frame at a fixed quality and looks for blocks whose recompression error is a statistical outlier, plus editor traces in EXIF.",
      evidence: i.tamper.tamper_signals.length
        ? i.tamper.tamper_signals.join("; ")
        : "Recompression error is uniform and no editor software tag is present.",
      recommendation: i.tamper.is_tampered_suspected
        ? "Escalate for manual forensic review before accepting the inspection."
        : "No action — ELA shows no localised editing signature.",
    },
    {
      key: "metadata_integrity",
      label: "Metadata integrity",
      status: i.has_exif ? (i.tamper.tamper_confidence >= 0.25 ? "warn" : "pass") : "warn",
      confidence: pct(i.has_exif ? 0.8 : 0.6),
      explanation:
        "Presence of an EXIF block, camera identity tags and an original capture timestamp establishes provenance. Absence is common for legitimate captures (messaging apps strip metadata), so it is reported as an advisory, never a failure.",
      evidence: i.has_exif
        ? "EXIF block present on the uploaded file."
        : "No EXIF block on the uploaded file — provenance cannot be corroborated from metadata alone.",
      recommendation: i.has_exif
        ? "No action — capture metadata is available for audit."
        : "Prefer originals straight from the capture app if provenance must be provable.",
    },
    {
      key: "synthetic_risk",
      label: "Synthetic Image Risk Assessment",
      status:
        i.ai.synthetic_risk_score > 70 ? "fail" : i.ai.synthetic_risk_score > 30 ? "warn" : "pass",
      confidence: i.ai.synthetic_risk_score,
      explanation:
        "Nine fused checks — metadata authenticity, screenshot indicators, OCR naturalness, texture consistency, reflection consistency, shadow consistency, plate realism, compression signature and object geometry — estimate whether this frame may be AI-generated, digitally synthesised, heavily edited or otherwise not an original field photograph. Heuristic risk indicator, not a definitive forensic determination.",
      evidence: `Verdict: ${i.ai.verdict} — synthetic risk ${i.ai.synthetic_risk_score}/100, authenticity ${i.ai.authenticity_score}/100, assessment confidence ${i.ai.assessment_confidence}%. ${i.ai.evidence.slice(0, 4).join(" ")}`,
      recommendation: i.ai.recommendation,
    },
  ];
}

/** Written assessment for the FieldSight report, grounded in the engine output. */
export function buildFieldSightSummary(args: {
  plate: string | null;
  plateValid: boolean;
  rtoState: string | null;
  rtoOffice: string | null;
  quality: Array<{ key: string; label: string; score: number }>;
  forensics: ForensicCheck[];
  engine: ConfidenceEngineResult;
  advertisementCoverage: number;
  ai?: { synthetic_risk_score: number; authenticity_score: number; verdict: string };
}): string {
  const lines: string[] = [];
  if (args.plate) {
    lines.push(
      `Vehicle registration ${args.plate} was ${args.plateValid ? "successfully detected and validated" : "detected but failed format validation"}` +
        (args.rtoState ? `, decoding to ${args.rtoOffice ?? "an unlisted RTO"} in ${args.rtoState}.` : "."),
    );
  } else {
    lines.push("No readable registration plate was detected in this image.");
  }

  const sharp = args.quality.find((q) => q.key === "sharpness")?.score ?? 0;
  const bright = args.quality.find((q) => q.key === "brightness")?.score ?? 0;
  const qualityWord = (sharp + bright) / 2 >= 7 ? "acceptable" : (sharp + bright) / 2 >= 5 ? "borderline" : "poor";
  lines.push(
    `Image quality is ${qualityWord} with sharpness ${sharp}/10 and brightness ${bright}/10.`,
  );

  const failures = args.forensics.filter((f) => f.status === "fail");
  const warnings = args.forensics.filter((f) => f.status === "warn");
  if (!failures.length && !warnings.length) {
    lines.push("No signs of screenshot artefacts, duplication or tampering were detected.");
  } else {
    if (failures.length)
      lines.push(`Failed forensic checks: ${failures.map((f) => f.label.toLowerCase()).join(", ")}.`);
    if (warnings.length)
      lines.push(`Advisory signals: ${warnings.map((f) => f.label.toLowerCase()).join(", ")}.`);
  }

  const ad = Math.round(args.advertisementCoverage * 100);
  if (ad >= 20) {
    lines.push(
      `Advertisement content occupies roughly ${ad}% of the image${ad >= 50 ? " and may interfere with registration visibility" : " but does not interfere with registration visibility"}.`,
    );
  }

  if (args.ai) {
    lines.push(
      `Synthetic Image Risk Assessment returns "${args.ai.verdict}" with a synthetic risk score of ${args.ai.synthetic_risk_score}/100 (authenticity ${args.ai.authenticity_score}/100); this is a heuristic risk indicator, not proof of generation.` +
        (args.engine.ai_deduction ? ` A ${args.engine.ai_deduction}-point deduction was applied to the trust score as a result.` : ""),
    );
  }

  lines.push(
    `Overall trust score is ${args.engine.trust_score}/100 (${args.engine.risk_level}) — ${verdictFor(args.engine.trust_score).toLowerCase()}.`,
  );
  return lines.join(" ");
}
