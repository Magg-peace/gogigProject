/**
 * Quality score cards (0..10) + overlay / advertisement heuristics.
 *
 * These are separate from the pass/fail forensic checks: a reviewer wants to see
 * "sharpness 8.2/10" next to "not blurry", because the boolean alone hides how
 * close the image sat to the threshold. Every score is a documented mapping from
 * one measurable pixel statistic; nothing here is a model output.
 */
import type { RgbaImage } from "./image.server";
import { clamp01, round, toGrayscale } from "./image.server";
import { BLUR_VARIANCE_THRESHOLD, LOW_LIGHT_THRESHOLD, MIN_DIMENSION } from "./checks.server";

export type QualityScore = {
  key: string;
  label: string;
  /** 0..10 */
  score: number;
  basis: string;
};

export type VisionSignals = {
  plate_visibility: number; // 0..1
  vehicle_visibility: number; // 0..1
  advertisement_coverage: number; // 0..1
  overlay_text_present: boolean;
};

const toTen = (v: number) => round(clamp01(v) * 10, 1);

export function computeContrast(img: RgbaImage) {
  const gray = toGrayscale(img);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  const mean = gray.length ? sum / gray.length : 0;
  let sq = 0;
  for (let i = 0; i < gray.length; i++) sq += (gray[i]! - mean) ** 2;
  const sd = Math.sqrt(gray.length ? sq / gray.length : 0);
  // Histogram spread at the 5th/95th percentile is more robust than min/max.
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]!]!++;
  let acc = 0;
  let p5 = 0;
  let p95 = 255;
  const lo = gray.length * 0.05;
  const hi = gray.length * 0.95;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (p5 === 0 && acc >= lo) p5 = v;
    if (acc >= hi) {
      p95 = v;
      break;
    }
  }
  return { contrast_stddev: round(sd, 2), dynamic_range: p95 - p5 };
}

/**
 * Metadata / GPS-camera overlay stamps: field apps burn a translucent dark band
 * with coordinates and a timestamp along one edge. Detect a horizontal band whose
 * rows are far darker and far flatter than the frame mean.
 */
export function detectOverlayBand(img: RgbaImage) {
  const gray = toGrayscale(img);
  const rowMean = new Float64Array(img.height);
  const rowSd = new Float64Array(img.height);
  for (let y = 0; y < img.height; y++) {
    let s = 0;
    for (let x = 0; x < img.width; x++) s += gray[y * img.width + x]!;
    const m = s / img.width;
    let q = 0;
    for (let x = 0; x < img.width; x++) q += (gray[y * img.width + x]! - m) ** 2;
    rowMean[y] = m;
    rowSd[y] = Math.sqrt(q / img.width);
  }
  const frameMean = rowMean.reduce((a, b) => a + b, 0) / (img.height || 1);
  const isBandRow = (y: number) => rowMean[y]! < frameMean * 0.55 && rowSd[y]! < 45;
  const scan = (fromBottom: boolean) => {
    let count = 0;
    const limit = Math.floor(img.height * 0.35);
    for (let i = 0; i < limit; i++) {
      const y = fromBottom ? img.height - 1 - i : i;
      if (isBandRow(y)) count++;
      else if (count > 0) break;
    }
    return count;
  };
  const bottom = scan(true);
  const top = scan(false);
  const rows = Math.max(bottom, top);
  const ratio = img.height ? rows / img.height : 0;
  return {
    overlay_band_detected: ratio >= 0.04,
    overlay_edge: rows === 0 ? null : bottom >= top ? "bottom" : "top",
    overlay_band_ratio: round(ratio),
  };
}

export function buildQualityScores(
  img: RgbaImage,
  blurScore: number,
  brightness: number,
  contrast: { contrast_stddev: number; dynamic_range: number },
  vision: VisionSignals,
): QualityScore[] {
  const sharpness = toTen(Math.log10(Math.max(1, blurScore)) / Math.log10(BLUR_VARIANCE_THRESHOLD * 8));
  // Ideal mean luma is ~125; score falls off symmetrically for dark and blown-out frames.
  const brightnessScore = toTen(1 - Math.abs(brightness - 125) / 125);
  const contrastScore = toTen(
    (clamp01(contrast.contrast_stddev / 60) + clamp01(contrast.dynamic_range / 200)) / 2,
  );
  const minSide = Math.min(img.width, img.height);
  const resolution = toTen(Math.min(1, minSide / (MIN_DIMENSION * 2.5)));
  return [
    {
      key: "sharpness",
      label: "Sharpness",
      score: sharpness,
      basis: `Laplacian edge variance ${blurScore} on a log scale against the ${BLUR_VARIANCE_THRESHOLD} blur floor.`,
    },
    {
      key: "brightness",
      label: "Brightness",
      score: brightnessScore,
      basis: `Mean luma ${brightness}/255; 125 scores 10, both under- and over-exposure are penalised (low-light floor ${LOW_LIGHT_THRESHOLD}).`,
    },
    {
      key: "contrast",
      label: "Contrast",
      score: contrastScore,
      basis: `Luma std-dev ${contrast.contrast_stddev} and 5–95 percentile dynamic range ${contrast.dynamic_range}/255.`,
    },
    {
      key: "resolution",
      label: "Resolution",
      score: resolution,
      basis: `${img.width}×${img.height}; the short side (${minSide}px) reaches 10/10 at ${MIN_DIMENSION * 2.5}px.`,
    },
    {
      key: "plate_visibility",
      label: "Plate visibility",
      score: toTen(vision.plate_visibility),
      basis: "Vision model estimate of how legibly the registration plate occupies the frame.",
    },
    {
      key: "vehicle_visibility",
      label: "Vehicle visibility",
      score: toTen(vision.vehicle_visibility),
      basis: "Vision model estimate of how much of the vehicle body is unobstructed and in frame.",
    },
  ];
}
