/**
 * SYNTHETIC IMAGE RISK ASSESSMENT
 *
 * ENGINEERING POSITION: this module is NOT a guaranteed AI detector. No
 * published detector — commercial ones included — can prove that a frame was
 * produced by Midjourney, DALL-E, Stable Diffusion, Flux, Ideogram, Leonardo or
 * any other generator. Every signal below is a *correlate* of synthesis and each
 * one has legitimate false-positive sources (heavy denoise, flat studio
 * backdrops, aggressive recompression, metadata stripped by messaging apps).
 *
 * The module therefore produces a graded Synthetic Risk Score (0-100), the
 * complementary Authenticity Score, an assessment confidence, and one of three
 * risk-based verdicts — "Likely Authentic", "Suspicious", "Likely Synthetic".
 * It never claims certainty.
 *
 * Nine checks, each returning its own 0..1 signal plus the evidence string that
 * produced it, so a reviewer can audit exactly which measurement fired.
 */
import type { RgbaImage } from "./image.server";
import { clamp01, fitWithin, resampleGray, round, toGrayscale } from "./image.server";
import type { ExifInfo } from "./exif.server";

export type SyntheticCheck = {
  key: string;
  label: string;
  /** 0..1 — how strongly this check leans "synthetic". */
  signal: number;
  weight: number;
  /** Points this check contributed to the 0-100 synthetic risk score. */
  contribution: number;
  evidence: string;
};

export type SyntheticVerdict = "Likely Authentic" | "Suspicious" | "Likely Synthetic";

export type SyntheticRiskResult = {
  /** 0-100, higher = more likely synthesised / not an original field photo. */
  synthetic_risk_score: number;
  /** 0-100, simply 100 - synthetic_risk_score. */
  authenticity_score: number;
  verdict: SyntheticVerdict;
  /** 0-100 — how much evidence the assessment itself had to work with. */
  assessment_confidence: number;
  checks: SyntheticCheck[];
  evidence: string[];
  recommendation: string;
  notes: string[];
  /** Back-compatible 0..1 / 0..100 mirrors of the risk score for stored columns. */
  ai_confidence: number;
  ai_confidence_pct: number;
};

/** Vision-model side of the assessment: semantic cues no pixel statistic can see. */
export type AiVisionHints = {
  text_artifacts: number; // 0..1 distorted letters, broken glyphs, inconsistent fonts
  plate_realism_issues: number; // 0..1 impossible spacing / alignment / rendering
  object_consistency_issues: number; // 0..1 warped parts, impossible shapes, broken symmetry
  reflection_issues: number; // 0..1 implausible window / body reflections, lighting realism
  shadow_issues: number; // 0..1 shadow direction, continuity, impossible lighting
  real_photo_probability: number; // 0..1 model's own belief this is a real photograph
  ai_generated_likelihood: number; // 0..1 model's own synthetic impression
  screenshot_probability: number; // 0..1 model's own screenshot impression
  vision_confidence: number; // 0..1 model's confidence in its own reasoning
  ai_notes: string[];
};

export const EMPTY_AI_VISION_HINTS: AiVisionHints = {
  text_artifacts: 0,
  plate_realism_issues: 0,
  object_consistency_issues: 0,
  reflection_issues: 0,
  shadow_issues: 0,
  real_photo_probability: 0,
  ai_generated_likelihood: 0,
  screenshot_probability: 0,
  vision_confidence: 0,
  ai_notes: [],
};

const GENERATOR_HINTS = [
  "midjourney", "dall-e", "dalle", "stable diffusion", "stablediffusion", "sdxl",
  "automatic1111", "comfyui", "flux", "ideogram", "leonardo", "grok", "firefly",
  "imagen", "nano banana", "openai", "generated", "diffusion", "invokeai", "novelai",
];

/** Common phone / desktop screen resolutions — a corroborating screenshot signal. */
const SCREEN_RESOLUTIONS = [
  [1080, 1920], [1170, 2532], [1179, 2556], [1284, 2778], [1290, 2796], [1440, 3120],
  [828, 1792], [750, 1334], [1125, 2436], [1080, 2340], [1080, 2400], [1440, 2560],
  [1366, 768], [1920, 1080], [2560, 1440], [3840, 2160], [1280, 800], [1440, 900],
  [1512, 982], [1728, 1117], [2048, 1536], [2732, 2048],
];

/* ---------------------------------------------------------------- pixel stats */

type BlockStats = { variance: number[]; residual: number[] };

function blockStatistics(img: RgbaImage): BlockStats {
  const gray = toGrayscale(img);
  const [w, h] = fitWithin(img.width, img.height, 512);
  const plane = resampleGray(gray, img.width, img.height, w, h);
  const block = 16;
  const variance: number[] = [];
  const residual: number[] = [];
  for (let by = 0; by + block <= h; by += block) {
    for (let bx = 0; bx + block <= w; bx += block) {
      let sum = 0;
      let sumSq = 0;
      let res = 0;
      let n = 0;
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block; x++) {
          const v = plane[y * w + x]!;
          sum += v;
          sumSq += v * v;
          // 4-neighbour high-pass residual approximates sensor noise + micro-texture.
          if (y > 0 && y < h - 1 && x > 0 && x < w - 1) {
            const hp =
              v - (plane[y * w + x - 1]! + plane[y * w + x + 1]! + plane[(y - 1) * w + x]! + plane[(y + 1) * w + x]!) / 4;
            res += Math.abs(hp);
            n++;
          }
        }
      }
      const mean = sum / (block * block);
      variance.push(Math.max(0, sumSq / (block * block) - mean * mean));
      residual.push(n ? res / n : 0);
    }
  }
  return { variance, residual };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 1;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0.0001) return 0;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return sd / mean;
}

/** Tile-signature collisions: diffusion output repeats texture motifs far more than sensor data. */
function repeatedTileRatio(img: RgbaImage): { ratio: number; tiles: number } {
  const gray = toGrayscale(img);
  const [w, h] = fitWithin(img.width, img.height, 384);
  const plane = resampleGray(gray, img.width, img.height, w, h);
  const tile = 24;
  const seen = new Map<string, number>();
  let tiles = 0;
  for (let by = 0; by + tile <= h; by += tile) {
    for (let bx = 0; bx + tile <= w; bx += tile) {
      let sum = 0;
      let sumSq = 0;
      let gx = 0;
      let gy = 0;
      for (let y = by; y < by + tile; y++) {
        for (let x = bx; x < bx + tile; x++) {
          const v = plane[y * w + x]!;
          sum += v;
          sumSq += v * v;
          if (x + 1 < bx + tile) gx += Math.abs(v - plane[y * w + x + 1]!);
          if (y + 1 < by + tile) gy += Math.abs(v - plane[(y + 1) * w + x]!);
        }
      }
      const n = tile * tile;
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
      const key = `${Math.round(mean / 6)}:${Math.round(sd / 3)}:${Math.round(gx / n)}:${Math.round(gy / n)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      tiles++;
    }
  }
  let repeated = 0;
  for (const count of seen.values()) if (count > 1) repeated += count - 1;
  return { ratio: tiles ? repeated / tiles : 0, tiles };
}

/* ---------------------------------------------------------------- assessment */

export type SyntheticRiskInputs = {
  image: RgbaImage;
  exif: ExifInfo;
  mimeType: string;
  hints?: AiVisionHints;
  /** From the screenshot / photo-of-photo heuristic. */
  screenshot_confidence?: number;
  /** OCR read used for the naturalness check. */
  ocr_confidence?: number;
  plate_present?: boolean;
  /** Sharpness score card, 0..10 — an unnaturally perfect plate is a cue. */
  sharpness_10?: number;
};

export function assessSyntheticRisk(input: SyntheticRiskInputs): SyntheticRiskResult {
  const { image: img, exif, mimeType } = input;
  const hints = input.hints ?? EMPTY_AI_VISION_HINTS;
  const notes: string[] = [];
  const checks: Array<Omit<SyntheticCheck, "contribution">> = [];

  /* CHECK 1 — metadata authenticity ------------------------------------ */
  const software = (exif.software ?? "").toLowerCase();
  const generatorTag = GENERATOR_HINTS.find((hint) => software.includes(hint));
  let metaSignal = 0;
  const metaEvidence: string[] = [];
  if (generatorTag) {
    metaSignal += 0.9;
    metaEvidence.push(`EXIF Software tag names a known generator ("${exif.software}")`);
  }
  if (!exif.hasExif) {
    metaSignal += 0.2;
    metaEvidence.push("no EXIF block at all (weak — messaging apps strip metadata too)");
  }
  if (!exif.make && !exif.model) {
    metaSignal += 0.12;
    metaEvidence.push("no camera make/model tags");
  }
  if (!exif.dateTimeOriginal) {
    metaSignal += 0.1;
    metaEvidence.push("no original capture timestamp");
  }
  if (mimeType === "image/png" && !exif.hasExif) {
    metaSignal += 0.08;
    metaEvidence.push("PNG container with no capture metadata — the default export of most generators");
  }
  checks.push({
    key: "metadata_authenticity",
    label: "Metadata authenticity",
    signal: clamp01(metaSignal),
    weight: 0.16,
    evidence: metaEvidence.length
      ? `${metaEvidence.join("; ")}.`
      : `Capture metadata present (${exif.make ?? "unknown make"} ${exif.model ?? ""}, captured ${exif.dateTimeOriginal ?? "unknown time"}) and names no generation software.`,
  });

  /* CHECK 2 — screenshot indicators ------------------------------------ */
  const screenMatch = SCREEN_RESOLUTIONS.some(
    ([a, b]) => (img.width === a && img.height === b) || (img.width === b && img.height === a),
  );
  const screenshotHeuristic = clamp01(input.screenshot_confidence ?? 0);
  const screenshotSignal = clamp01(
    screenshotHeuristic * 0.55 +
      (screenMatch ? 0.3 : 0) +
      (mimeType === "image/png" ? 0.1 : 0) +
      clamp01(hints.screenshot_probability) * 0.25,
  );
  checks.push({
    key: "screenshot_indicators",
    label: "Screenshot indicators",
    signal: screenshotSignal,
    weight: 0.1,
    evidence: `Container ${mimeType}, ${img.width}×${img.height}px${screenMatch ? " matches a known device screen resolution" : " does not match a known screen resolution"}; screenshot heuristic at ${Math.round(screenshotHeuristic * 100)}%, vision model at ${Math.round(clamp01(hints.screenshot_probability) * 100)}%.`,
  });

  /* CHECK 3 — OCR naturalness ------------------------------------------ */
  const ocrConf = clamp01(input.ocr_confidence ?? 0);
  const sharp = Math.max(0, Math.min(10, input.sharpness_10 ?? 0));
  // A real field photo almost never yields a *perfect* read on a *perfectly*
  // sharp plate — that combination is far more typical of rendered text.
  const perfectRead = ocrConf >= 0.98 && (input.plate_present ?? false) ? 0.45 : 0;
  const perfectSharp = sharp >= 9.5 ? 0.3 : 0;
  const ocrSignal = clamp01(perfectRead + perfectSharp + clamp01(hints.text_artifacts) * 0.6);
  checks.push({
    key: "ocr_naturalness",
    label: "OCR naturalness",
    signal: ocrSignal,
    weight: 0.1,
    evidence: `Plate read at ${Math.round(ocrConf * 100)}% confidence on a frame scoring ${sharp}/10 for sharpness; vision model reports glyph irregularities at ${Math.round(clamp01(hints.text_artifacts) * 100)}%.${perfectRead || perfectSharp ? " Unrealistically clean text rendering is itself a synthetic cue." : ""}`,
  });

  /* CHECK 4 — texture consistency -------------------------------------- */
  const stats = blockStatistics(img);
  const medVar = median(stats.variance);
  const flatBlocks = stats.variance.length
    ? stats.variance.filter((v) => v < 12).length / stats.variance.length
    : 0;
  const repeat = repeatedTileRatio(img);
  const smoothSignal = clamp01((260 - medVar) / 260) * 0.6 + clamp01((flatBlocks - 0.25) / 0.5) * 0.4;
  const textureSignal = clamp01(smoothSignal * 0.7 + clamp01((repeat.ratio - 0.05) / 0.35) * 0.3);
  checks.push({
    key: "texture_consistency",
    label: "Texture consistency",
    signal: textureSignal,
    weight: 0.14,
    evidence: `Median 16px block variance ${round(medVar, 1)}, ${(flatBlocks * 100).toFixed(1)}% of blocks near-flat (over-smoothed surfaces), ${(repeat.ratio * 100).toFixed(1)}% of ${repeat.tiles} tiles share a repeated texture signature.`,
  });

  /* CHECK 5 — reflection consistency (vision) -------------------------- */
  checks.push({
    key: "reflection_consistency",
    label: "Reflection consistency",
    signal: clamp01(hints.reflection_issues),
    weight: 0.1,
    evidence:
      hints.reflection_issues > 0.15
        ? `Vision model reports implausible body/window reflections or lighting that does not match the scene, at ${Math.round(hints.reflection_issues * 100)}%.`
        : "Body and window reflections are consistent with the apparent light sources in the scene.",
  });

  /* CHECK 6 — shadow consistency (vision) ------------------------------ */
  checks.push({
    key: "shadow_consistency",
    label: "Shadow consistency",
    signal: clamp01(hints.shadow_issues),
    weight: 0.1,
    evidence:
      hints.shadow_issues > 0.15
        ? `Shadow direction or continuity problems reported at ${Math.round(hints.shadow_issues * 100)}% — impossible lighting is a strong synthesis cue.`
        : "Shadow direction and continuity are internally consistent across the frame.",
  });

  /* CHECK 7 — plate realism (vision) ----------------------------------- */
  checks.push({
    key: "plate_realism",
    label: "Plate realism",
    signal: clamp01(hints.plate_realism_issues),
    weight: 0.12,
    evidence:
      hints.plate_realism_issues > 0.15
        ? `Plate geometry looks rendered rather than physical (character spacing, baseline alignment, edge attachment) at ${Math.round(hints.plate_realism_issues * 100)}%.`
        : "Plate character spacing, alignment and mounting are consistent with a physical plate.",
  });

  /* CHECK 8 — compression signature ------------------------------------ */
  const residualMean = stats.residual.length
    ? stats.residual.reduce((a, b) => a + b, 0) / stats.residual.length
    : 0;
  const residualCv = coefficientOfVariation(stats.residual);
  // Camera noise varies strongly between sky, shadow and texture; diffusion
  // denoising leaves an unnaturally uniform residual field.
  const noiseSignal = clamp01(
    clamp01((0.55 - residualCv) / 0.55) * 0.6 + clamp01((1.6 - residualMean) / 1.6) * 0.4,
  );
  checks.push({
    key: "compression_signature",
    label: "Compression signature",
    signal: noiseSignal,
    weight: 0.14,
    evidence: `Mean high-pass residual ${round(residualMean, 3)} with a coefficient of variation of ${round(residualCv, 3)} across ${stats.residual.length} blocks; natural JPEG/sensor noise is far less uniform than diffusion smoothness.`,
  });

  /* CHECK 9 — object geometry (vision) --------------------------------- */
  checks.push({
    key: "object_geometry",
    label: "Object geometry",
    signal: clamp01(hints.object_consistency_issues),
    weight: 0.14,
    evidence:
      hints.object_consistency_issues > 0.15
        ? `Geometry problems reported (warped panels, distorted wheels, broken symmetry or impossible perspective) at ${Math.round(hints.object_consistency_issues * 100)}%.`
        : "Vehicle proportions, wheel geometry and perspective are internally consistent.",
  });

  /* fusion -------------------------------------------------------------- */
  const weightSum = checks.reduce((a, c) => a + c.weight, 0) || 1;
  const weighted = checks.reduce((a, c) => a + c.signal * c.weight, 0);
  let risk = clamp01(weighted / weightSum);
  // The vision model's own holistic impression is blended in, but never allowed
  // to dominate the measurable pixel evidence.
  risk = clamp01(risk * 0.75 + clamp01(hints.ai_generated_likelihood) * 0.25);
  // A confident "this is a real photograph" reading pulls the risk down.
  if (hints.real_photo_probability >= 0.8 && hints.vision_confidence >= 0.6) {
    risk = clamp01(risk * 0.8);
    notes.push(
      `The vision model rates this as a real photograph with ${Math.round(hints.real_photo_probability * 100)}% probability, which moderates the pixel-level risk.`,
    );
  }

  // Guard rail against the known false positive: metadata absence alone.
  const corroborated = checks
    .filter((c) => c.key !== "metadata_authenticity")
    .some((c) => c.signal >= 0.5);
  if (!corroborated && !generatorTag) {
    const capped = Math.min(risk, 0.45);
    if (capped < risk) {
      notes.push(
        "Only weak metadata signals fired — no pixel-level or semantic corroboration — so the risk is capped inside the 'Suspicious' band and never escalates to 'Likely Synthetic'.",
      );
    }
    risk = capped;
  }
  if (generatorTag) {
    notes.push(`A generation tool is named directly in the file metadata ("${exif.software}").`);
  }
  notes.push(...hints.ai_notes.slice(0, 6));
  notes.push(
    "Synthetic Image Risk Assessment is heuristic-based and intended as a risk indicator, not a definitive forensic determination.",
  );

  const score = Math.round(risk * 100);
  const verdict: SyntheticVerdict =
    score > 70 ? "Likely Synthetic" : score > 30 ? "Suspicious" : "Likely Authentic";

  /**
   * Assessment confidence is about the *evidence base*, not the verdict: a frame
   * with EXIF, a vision reading and enough pixels supports a far stronger
   * statement than a stripped 300px thumbnail with no vision result.
   */
  const evidenceBase =
    (exif.hasExif ? 0.2 : 0.05) +
    (hints.vision_confidence > 0 ? 0.25 + clamp01(hints.vision_confidence) * 0.2 : 0) +
    (Math.min(img.width, img.height) >= 600 ? 0.2 : 0.08) +
    (stats.variance.length >= 200 ? 0.15 : 0.05) +
    (generatorTag ? 0.2 : 0);
  const assessmentConfidence = Math.round(clamp01(evidenceBase) * 100);

  const recommendation =
    score > 70
      ? "Route to manual review before acceptance and request an original capture straight from the field app. Treat as suspected synthetic media, not proven."
      : score > 30
        ? "Advisory only: some synthetic correlates fired. Corroborate with the field agent or a second capture if this inspection carries financial or legal weight."
        : "No action — the frame is consistent with an original field photograph.";

  const evidence = checks
    .filter((c) => c.signal >= 0.25)
    .sort((a, b) => b.signal * b.weight - a.signal * a.weight)
    .map((c) => `${c.label}: ${c.evidence}`);
  if (!evidence.length) evidence.push("No individual check fired above 25% — no material synthetic correlates were found.");

  return {
    synthetic_risk_score: score,
    authenticity_score: 100 - score,
    verdict,
    assessment_confidence: assessmentConfidence,
    checks: checks.map((c) => ({
      ...c,
      signal: round(c.signal),
      contribution: Number(((c.signal * c.weight * 100) / weightSum).toFixed(2)),
    })),
    evidence,
    recommendation,
    notes,
    ai_confidence: round(risk),
    ai_confidence_pct: score,
  };
}
