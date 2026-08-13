// The seven analysis checks. Each is an exported pure function over decoded
// pixels (plus, for OCR, the raw bytes) so they can be unit-tested in isolation
// and re-ordered or swapped without touching the worker.
//
// Every check returns a CONFIDENCE (0..1) alongside its boolean. These are
// heuristics, not ground truth: the boolean is only "confidence crossed the
// threshold we picked", and the UI is required to surface the number.
import jpeg from "jpeg-js";
import type { RgbaImage } from "./image.server";
import { clamp01, fitWithin, resampleGray, round, toGrayscale } from "./image.server";
import type { ExifInfo } from "./exif.server";
import type { AiVisionHints } from "./synthetic-risk.server";
import { EMPTY_AI_VISION_HINTS } from "./synthetic-risk.server";

export const BLUR_WORK_SIZE = 512; // resolution blur is normalised to
export const BLUR_VARIANCE_THRESHOLD = 120;
export const LOW_LIGHT_THRESHOLD = 62; // mean luma 0..255
export const HAMMING_DUPLICATE_THRESHOLD = 8; // out of 64 bits
export const MIN_DIMENSION = 480;
export const INDIAN_PLATE_REGEX = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/;

/* 1. BLUR -------------------------------------------------------------- */
export function detectBlur(img: RgbaImage) {
  const gray = toGrayscale(img);
  const [w, h] = fitWithin(img.width, img.height, BLUR_WORK_SIZE);
  const plane = resampleGray(gray, img.width, img.height, w, h);
  // 4-neighbour Laplacian kernel; variance of the response approximates edge energy.
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * plane[i]! - plane[i - 1]! - plane[i + 1]! - plane[i - w]! - plane[i + w]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  const variance = n ? sumSq / n - mean * mean : 0;
  const isBlurry = variance < BLUR_VARIANCE_THRESHOLD;
  // Confidence ramps linearly from the threshold down to a quarter of it.
  const confidence = clamp01((BLUR_VARIANCE_THRESHOLD - variance) / (BLUR_VARIANCE_THRESHOLD * 0.75));
  return { blur_score: round(variance, 2), is_blurry: isBlurry, blur_confidence: round(confidence) };
}

/* 2. BRIGHTNESS / LOW LIGHT -------------------------------------------- */
export function detectLowLight(img: RgbaImage) {
  const gray = toGrayscale(img);
  let sum = 0;
  let dark = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i]!;
    if (gray[i]! < 40) dark++;
  }
  const mean = gray.length ? sum / gray.length : 0;
  const darkRatio = gray.length ? dark / gray.length : 0;
  const isLowLight = mean < LOW_LIGHT_THRESHOLD;
  const confidence = clamp01(((LOW_LIGHT_THRESHOLD - mean) / LOW_LIGHT_THRESHOLD) * 0.7 + darkRatio * 0.5);
  return {
    brightness_score: round(mean, 2),
    dark_pixel_ratio: round(darkRatio),
    is_low_light: isLowLight,
    low_light_confidence: round(confidence),
  };
}

/* 3. PERCEPTUAL HASH / DUPLICATES -------------------------------------- */
/** 64-bit difference hash: compare each pixel with its right neighbour on a 9x8 grid. */
export function computeDifferenceHash(img: RgbaImage): string {
  const gray = toGrayscale(img);
  const plane = resampleGray(gray, img.width, img.height, 9, 8);
  let hex = "";
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = plane[y * 9 + x]! > plane[y * 9 + x + 1]! ? 1 : 0;
      nibble = (nibble << 1) | bit;
      if (++bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

export function findDuplicate(
  hash: string,
  existing: Array<{ upload_id: string; image_hash: string | null }>,
) {
  let best: { upload_id: string; distance: number } | null = null;
  for (const row of existing) {
    if (!row.image_hash) continue;
    const distance = hammingDistance(hash, row.image_hash);
    if (!best || distance < best.distance) best = { upload_id: row.upload_id, distance };
  }
  const isDuplicate = !!best && best.distance <= HAMMING_DUPLICATE_THRESHOLD;
  return {
    is_duplicate: isDuplicate,
    duplicate_of_upload_id: isDuplicate ? best!.upload_id : null,
    nearest_distance: best ? best.distance : null,
    duplicate_confidence: best ? round(clamp01(1 - best.distance / 16)) : 0,
  };
}

/* 4. SCREENSHOT / PHOTO-OF-PHOTO --------------------------------------- */
const COMMON_SCREEN_SIZES = new Set([
  "1080x1920", "1920x1080", "750x1334", "1125x2436", "1170x2532", "1284x2778",
  "828x1792", "1440x2560", "1080x2340", "1080x2400", "1366x768", "1280x720",
  "2560x1440", "1440x900", "1920x1200", "2880x1800",
]);

function isPowerOfTwo(n: number) {
  return n > 0 && (n & (n - 1)) === 0;
}

export function detectScreenshot(img: RgbaImage, exif: ExifInfo, mimeType: string) {
  const signals: string[] = [];
  // Signals are split into WEAK (routinely true of legitimate field captures —
  // messaging apps and capture tools strip EXIF and re-encode as PNG) and
  // CORROBORATING (structurally screenshot-like). Weak signals alone can only
  // ever produce a "warn"; a fail requires at least one corroborating signal.
  let weak = 0;
  let strong = 0;
  if (!exif.hasExif) {
    weak += 0.25;
    signals.push("no EXIF block present (weak on its own — capture apps strip metadata)");
  }
  if (!exif.make && !exif.model) {
    weak += 0.1;
    signals.push("no camera make/model tags (weak signal)");
  }
  if (mimeType === "image/png") {
    weak += 0.1;
    signals.push("PNG container (weak signal — field apps re-encode legitimate photos as PNG)");
  }
  const key = `${img.width}x${img.height}`;
  if (COMMON_SCREEN_SIZES.has(key)) {
    strong += 0.4;
    signals.push(`dimensions ${key} match a known device screen resolution`);
  }
  if (isPowerOfTwo(img.width) && isPowerOfTwo(img.height)) {
    strong += 0.15;
    signals.push("both dimensions are exact powers of two");
  }
  const chrome = detectUiChrome(img);
  if (chrome.hasUniformBorder) {
    strong += 0.2;
    signals.push(`uniform flat band along ${chrome.borderEdges.join(", ")} — possible UI chrome or letterboxing`);
  }
  const hasCorroboration = strong > 0;
  // Cap below the 0.55 fail threshold when nothing corroborates the weak signals.
  const confidence = hasCorroboration
    ? clamp01(weak + strong)
    : Math.min(clamp01(weak), 0.45);
  if (!hasCorroboration && weak > 0) {
    signals.push(
      "no corroborating signal (device-resolution match, power-of-two dimensions or UI chrome) — treated as a warning, not a failure",
    );
  }
  return {
    is_screenshot_or_rephoto: confidence >= 0.55,
    screenshot_confidence: round(confidence),
    screenshot_signals: signals,
  };
}

/** Flat, near-constant rows/columns at the edges: status bars, app chrome, letterboxing. */
function detectUiChrome(img: RgbaImage) {
  const gray = toGrayscale(img);
  const edges: string[] = [];
  const rowFlat = (y: number) => {
    let min = 255;
    let max = 0;
    for (let x = 0; x < img.width; x++) {
      const v = gray[y * img.width + x]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min < 6;
  };
  const colFlat = (x: number) => {
    let min = 255;
    let max = 0;
    for (let y = 0; y < img.height; y++) {
      const v = gray[y * img.width + x]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min < 6;
  };
  const band = Math.max(2, Math.floor(Math.min(img.width, img.height) * 0.02));
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < band; i++) {
    if (rowFlat(i)) top++;
    if (rowFlat(img.height - 1 - i)) bottom++;
    if (colFlat(i)) left++;
    if (colFlat(img.width - 1 - i)) right++;
  }
  if (top === band) edges.push("top");
  if (bottom === band) edges.push("bottom");
  if (left === band) edges.push("left");
  if (right === band) edges.push("right");
  return { hasUniformBorder: edges.length > 0, borderEdges: edges };
}

/* 5. TAMPER SUSPICION (ELA + metadata) --------------------------------- */
const EDITOR_HINTS = [
  "photoshop", "gimp", "lightroom", "snapseed", "picsart", "canva", "pixlr",
  "affinity", "paint.net", "faceapp", "remini",
];

export function detectTampering(img: RgbaImage, exif: ExifInfo) {
  const signals: string[] = [];
  // Error Level Analysis: re-encode at a known quality and measure how unevenly
  // the recompression error is distributed. Regions that were previously saved
  // at a different quality (i.e. pasted in) light up as high-error outliers.
  const ela = errorLevelAnalysis(img);
  let score = clamp01((ela.outlier_block_ratio - 0.02) / 0.18) * 0.6;
  if (ela.outlier_block_ratio > 0.02) {
    signals.push(
      `${(ela.outlier_block_ratio * 100).toFixed(1)}% of 16px blocks show abnormal recompression error`,
    );
  }
  const software = (exif.software ?? "").toLowerCase();
  const editor = EDITOR_HINTS.find((hint) => software.includes(hint));
  if (editor) {
    score += 0.45;
    signals.push(`EXIF Software tag mentions an image editor: "${exif.software}"`);
  }
  if (exif.hasExif && !exif.dateTimeOriginal) {
    score += 0.1;
    signals.push("EXIF present but DateTimeOriginal stripped — typical of a re-save");
  }
  const confidence = clamp01(score);
  return {
    is_tampered_suspected: confidence >= 0.5,
    tamper_confidence: round(confidence),
    tamper_signals: signals,
    ela,
  };
}

function errorLevelAnalysis(img: RgbaImage) {
  const [w, h] = fitWithin(img.width, img.height, 640);
  const scaled = resampleRgba(img, w, h);
  const encoded = jpeg.encode({ data: scaled.data as unknown as Buffer, width: w, height: h }, 80);
  const reDecoded = jpeg.decode(encoded.data, { useTArray: true, formatAsRGBA: true });
  const block = 16;
  const blockErrors: number[] = [];
  for (let by = 0; by + block <= h; by += block) {
    for (let bx = 0; bx + block <= w; bx += block) {
      let acc = 0;
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block; x++) {
          const i = (y * w + x) * 4;
          acc +=
            Math.abs(scaled.data[i]! - reDecoded.data[i]!) +
            Math.abs(scaled.data[i + 1]! - reDecoded.data[i + 1]!) +
            Math.abs(scaled.data[i + 2]! - reDecoded.data[i + 2]!);
        }
      }
      blockErrors.push(acc / (block * block * 3));
    }
  }
  const mean = blockErrors.reduce((a, b) => a + b, 0) / (blockErrors.length || 1);
  const sd = Math.sqrt(
    blockErrors.reduce((a, b) => a + (b - mean) ** 2, 0) / (blockErrors.length || 1),
  );
  const outliers = blockErrors.filter((e) => e > mean + 3 * sd).length;
  return {
    mean_block_error: round(mean, 3),
    stddev_block_error: round(sd, 3),
    outlier_block_ratio: round(blockErrors.length ? outliers / blockErrors.length : 0),
    blocks_measured: blockErrors.length,
  };
}

function resampleRgba(img: RgbaImage, targetW: number, targetH: number): RgbaImage {
  const out = new Uint8Array(targetW * targetH * 4);
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / targetH));
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / targetW));
      const s = (sy * img.width + sx) * 4;
      const d = (y * targetW + x) * 4;
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
      out[d + 3] = 255;
    }
  }
  return { width: targetW, height: targetH, data: out };
}

/* 6. OCR + INDIAN PLATE FORMAT ----------------------------------------- */
export function normalisePlateText(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/IND\b/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

export function validateIndianPlate(candidate: string | null) {
  const normalised = candidate ? normalisePlateText(candidate) : "";
  return {
    extracted_vehicle_number: normalised || null,
    vehicle_number_valid_format: normalised ? INDIAN_PLATE_REGEX.test(normalised) : false,
  };
}

/** Vision-model OCR. No Tesseract build runs in the Worker sandbox, so the plate
 *  read is delegated to a multimodal LLM over the AI gateway. */
export async function runPlateOcr(
  base64Image: string,
  mimeType: string,
  apiKey: string,
): Promise<{ raw_text: string | null; model_confidence: number; note: string }> {
  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content:
            'You read Indian vehicle number plates from photos. Reply with JSON only: {"plate": string|null, "confidence": number between 0 and 1}. Return the plate exactly as printed, without spaces. If no plate is legible, return null.',
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the vehicle registration number from this image." },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`OCR provider returned ${response.status}: ${await response.text()}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const match = content.match(/\{[\s\S]*\}/);
  let plate: string | null = null;
  let confidence = 0;
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { plate?: string | null; confidence?: number };
      plate = parsed.plate ?? null;
      confidence = clamp01(parsed.confidence ?? 0);
    } catch {
      plate = null;
    }
  }
  return {
    raw_text: plate,
    model_confidence: round(confidence),
    note: "OCR output is probabilistic; treat the plate string as a suggestion, not a verified registration.",
  };
}

/* 7. DIMENSIONS --------------------------------------------------------- */
export function validateDimensions(img: RgbaImage) {
  const insufficient = img.width < MIN_DIMENSION || img.height < MIN_DIMENSION;
  const smallestSide = Math.min(img.width, img.height);
  return {
    image_width: img.width,
    image_height: img.height,
    insufficient_resolution: insufficient,
    resolution_confidence: round(clamp01((MIN_DIMENSION - smallestSide) / MIN_DIMENSION)),
  };
}

/* OVERALL --------------------------------------------------------------- */
/** Confidence that the image is ACCEPTABLE. Worst offending signal dominates,
 *  with the rest contributing a smaller penalty, so one severe issue is never
 *  averaged away by four clean checks. */
export function computeOverallConfidence(penalties: number[]): number {
  if (!penalties.length) return 1;
  const sorted = [...penalties].sort((a, b) => b - a);
  const worst = sorted[0]!;
  const rest = sorted.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, sorted.length - 1);
  return round(clamp01(1 - (worst * 0.7 + rest * 0.3)));
}
/* 8. FULL VISION EXTRACTION -------------------------------------------- */
/**
 * One multimodal call does plate reading, plate localisation, scene-level
 * visibility estimation and text-entity extraction. Batching them into a single
 * request keeps latency and cost to one round-trip and guarantees the entities
 * and the plate come from the same read of the same frame.
 *
 * Tesseract is not used: no native binary or WASM worker pool runs inside the
 * edge worker sandbox. The vision model is the OCR engine, and every value it
 * returns is stored with its own confidence so nothing is presented as certain.
 */
export type OcrEntity = {
  type:
    | "vehicle_number" | "phone" | "task_id" | "date" | "time" | "address"
    | "gps" | "business_name" | "advertisement" | "other";
  value: string;
  confidence: number;
};

export type VisionExtraction = {
  raw_text: string | null;
  model_confidence: number;
  /** Normalised 0..1 [x, y, w, h] of the plate within the frame. */
  plate_bbox: [number, number, number, number] | null;
  plate_visibility: number;
  vehicle_visibility: number;
  advertisement_coverage: number;
  overlay_text_present: boolean;
  full_text: string | null;
  entities: OcrEntity[];
  note: string;
  /** Vehicle-level detection, independent of the plate read. */
  vehicle_present: boolean;
  vehicle_type: string | null;
  vehicle_confidence: number;
  vehicle_bbox: [number, number, number, number] | null;
  vehicle_colour: string | null;
  /** Semantic synthetic-image cues; consumed by the AI-generation detector. */
  ai_hints: AiVisionHints;
};

const VISION_SYSTEM_PROMPT = `You are an OCR and scene-analysis engine for Indian vehicle field-verification photos.
Reply with JSON only, no prose, matching exactly:
{
  "plate": string|null,                  // registration exactly as printed, no spaces, null if illegible
  "plate_confidence": number,            // 0..1
  "plate_bbox": [number,number,number,number]|null, // normalised x,y,w,h of the plate
  "plate_visibility": number,            // 0..1 how legibly the plate occupies the frame
  "vehicle_visibility": number,          // 0..1 how much of the vehicle is unobstructed and in frame
  "vehicle_present": boolean,            // is any vehicle visible at all
  "vehicle_type": string|null,           // e.g. "Auto Rickshaw", "Motorcycle", "Hatchback", "Truck", "Bus"
  "vehicle_confidence": number,          // 0..1 confidence in vehicle_present + vehicle_type
  "vehicle_bbox": [number,number,number,number]|null, // normalised x,y,w,h of the vehicle
  "vehicle_colour": string|null,         // dominant body colour, null if unclear
  "advertisement_coverage": number,      // 0..1 fraction of the frame taken by ad / branding / promo text
  "overlay_text_present": boolean,       // burned-in GPS/timestamp/app overlay stamps
  "full_text": string|null,              // all legible text in the image
  "entities": [ { "type": "vehicle_number|phone|task_id|date|time|address|gps|business_name|advertisement|other", "value": string, "confidence": number } ],
  "text_artifacts": number,              // 0..1 distorted letters, inconsistent fonts, broken glyph rendering
  "plate_realism_issues": number,        // 0..1 impossible character spacing, irregular alignment, abnormal reflections
  "object_consistency_issues": number,   // 0..1 warped vehicle parts, distorted wheels, broken symmetry, impossible perspective
  "reflection_issues": number,           // 0..1 implausible body/window reflections or lighting realism problems
  "shadow_issues": number,               // 0..1 shadow direction, continuity or impossible lighting problems
  "real_photo": boolean,                 // is this likely an original photograph of a physically present vehicle
  "real_photo_probability": number,      // 0..1
  "screenshot_probability": number,      // 0..1 likelihood this is a screenshot or photo-of-a-screen
  "vision_confidence": number,           // 0..1 your confidence in this whole analysis
  "ai_generated_likelihood": number,     // 0..1 overall impression that this frame was produced by a diffusion model
  "ai_notes": [string]                   // short factual observations supporting the above; [] if nothing stood out
}
Only report entities you can actually read. Never invent values.
Also judge: is the vehicle physically present, is the licence plate naturally attached to it, and are there synthetic rendering artifacts?
Never claim certainty about AI generation: express it only as graded 0..1 likelihoods.`;

const ENTITY_TYPES = new Set([
  "vehicle_number", "phone", "task_id", "date", "time", "address", "gps",
  "business_name", "advertisement", "other",
]);

export async function runVisionExtraction(
  base64Image: string,
  mimeType: string,
  apiKey: string,
): Promise<VisionExtraction> {
  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyse this vehicle verification photo." },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`OCR provider returned ${response.status}: ${await response.text()}`);
  }
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const match = content.match(/\{[\s\S]*\}/);
  const fallback: VisionExtraction = {
    raw_text: null, model_confidence: 0, plate_bbox: null, plate_visibility: 0,
    vehicle_visibility: 0, advertisement_coverage: 0, overlay_text_present: false,
    full_text: null, entities: [],
    note: "Vision extraction returned no parseable JSON; treated as an empty read.",
    vehicle_present: false, vehicle_type: null, vehicle_confidence: 0,
    vehicle_bbox: null, vehicle_colour: null,
    ai_hints: { ...EMPTY_AI_VISION_HINTS },
  };
  if (!match) return fallback;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return fallback;
  }

  const numberOr = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? clamp01(v) : d);
  const bboxRaw = parsed["plate_bbox"];
  const bbox =
    Array.isArray(bboxRaw) && bboxRaw.length === 4 && bboxRaw.every((n) => typeof n === "number")
      ? (bboxRaw.map((n) => round(clamp01(n as number))) as [number, number, number, number])
      : null;
  const vBoxRaw = parsed["vehicle_bbox"];
  const vehicleBbox =
    Array.isArray(vBoxRaw) && vBoxRaw.length === 4 && vBoxRaw.every((n) => typeof n === "number")
      ? (vBoxRaw.map((n) => round(clamp01(n as number))) as [number, number, number, number])
      : null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : null);
  const entitiesRaw = Array.isArray(parsed["entities"]) ? parsed["entities"] : [];
  const entities: OcrEntity[] = entitiesRaw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      type: (ENTITY_TYPES.has(String(e["type"])) ? String(e["type"]) : "other") as OcrEntity["type"],
      value: String(e["value"] ?? "").slice(0, 300),
      confidence: round(numberOr(e["confidence"], 0.5)),
    }))
    .filter((e) => e.value.trim().length > 0)
    .slice(0, 40);

  return {
    raw_text: typeof parsed["plate"] === "string" && parsed["plate"] ? String(parsed["plate"]) : null,
    model_confidence: round(numberOr(parsed["plate_confidence"])),
    plate_bbox: bbox,
    plate_visibility: round(numberOr(parsed["plate_visibility"])),
    vehicle_visibility: round(numberOr(parsed["vehicle_visibility"])),
    advertisement_coverage: round(numberOr(parsed["advertisement_coverage"])),
    overlay_text_present: parsed["overlay_text_present"] === true,
    full_text: typeof parsed["full_text"] === "string" ? parsed["full_text"].slice(0, 4000) : null,
    entities,
    note: "OCR and scene estimates are model outputs; every value carries its own confidence and must not be treated as verified fact.",
    vehicle_present: parsed["vehicle_present"] === true || numberOr(parsed["vehicle_visibility"]) > 0.15,
    vehicle_type: str(parsed["vehicle_type"]),
    vehicle_confidence: round(numberOr(parsed["vehicle_confidence"])),
    vehicle_bbox: vehicleBbox,
    vehicle_colour: str(parsed["vehicle_colour"]),
    ai_hints: {
      text_artifacts: round(numberOr(parsed["text_artifacts"])),
      plate_realism_issues: round(numberOr(parsed["plate_realism_issues"])),
      object_consistency_issues: round(numberOr(parsed["object_consistency_issues"])),
      reflection_issues: round(numberOr(parsed["reflection_issues"])),
      shadow_issues: round(numberOr(parsed["shadow_issues"])),
      real_photo_probability: round(
        numberOr(parsed["real_photo_probability"], parsed["real_photo"] === true ? 0.8 : 0),
      ),
      screenshot_probability: round(numberOr(parsed["screenshot_probability"])),
      vision_confidence: round(numberOr(parsed["vision_confidence"], 0.5)),
      ai_generated_likelihood: round(numberOr(parsed["ai_generated_likelihood"])),
      ai_notes: Array.isArray(parsed["ai_notes"])
        ? (parsed["ai_notes"] as unknown[])
            .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
            .map((n) => n.trim().slice(0, 240))
            .slice(0, 6)
        : [],
    },
  };
}
