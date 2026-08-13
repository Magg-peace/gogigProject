// Pure-JS image decoding. The Worker runtime has no native canvas / sharp / OpenCV,
// so every pixel operation below is hand-rolled over a plain RGBA byte buffer.
import jpeg from "jpeg-js";
import { decode as decodePng } from "fast-png";

export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, 4 bytes per pixel
};

export function decodeImage(bytes: Uint8Array, mimeType: string): RgbaImage {
  if (mimeType === "image/png") {
    const png = decodePng(bytes);
    const out = new Uint8Array(png.width * png.height * 4);
    const src = png.data as unknown as ArrayLike<number>;
    const channels = png.channels ?? 4;
    const scale = png.depth === 16 ? 1 / 257 : 1;
    for (let i = 0, p = 0; p < png.width * png.height; p++) {
      const s = p * channels;
      const r = Math.round((src[s] ?? 0) * scale);
      const g = channels >= 3 ? Math.round((src[s + 1] ?? 0) * scale) : r;
      const b = channels >= 3 ? Math.round((src[s + 2] ?? 0) * scale) : r;
      const a =
        channels === 4 ? Math.round((src[s + 3] ?? 255) * scale) : channels === 2 ? Math.round((src[s + 1] ?? 255) * scale) : 255;
      out[i++] = r;
      out[i++] = g;
      out[i++] = b;
      out[i++] = a;
    }
    return { width: png.width, height: png.height, data: out };
  }
  const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { width: raw.width, height: raw.height, data: new Uint8Array(raw.data) };
}

/** ITU-R BT.601 luma, one byte per pixel. */
export function toGrayscale(img: RgbaImage): Uint8Array {
  const gray = new Uint8Array(img.width * img.height);
  for (let p = 0; p < gray.length; p++) {
    const s = p * 4;
    gray[p] = (0.299 * img.data[s]! + 0.587 * img.data[s + 1]! + 0.114 * img.data[s + 2]!) | 0;
  }
  return gray;
}

/**
 * Nearest-neighbour box resample of a grayscale plane. Used to normalise blur
 * scores across resolutions: Laplacian variance grows with pixel density, so a
 * 12MP photo and a 640px photo of the same scene are only comparable after both
 * are resampled to a fixed working size.
 */
export function resampleGray(
  gray: Uint8Array,
  width: number,
  height: number,
  targetW: number,
  targetH: number,
): Uint8Array {
  const out = new Uint8Array(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / targetH));
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / targetW));
      out[y * targetW + x] = gray[sy * width + sx]!;
    }
  }
  return out;
}

export function fitWithin(width: number, height: number, maxDim: number): [number, number] {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function round(value: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}