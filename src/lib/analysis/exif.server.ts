// Minimal JPEG APP1/EXIF reader. We only need three things — does camera
// metadata exist at all, which device produced it, and whether an editor stamped
// the Software tag — so a full EXIF library (and its bundle weight) is not worth it.

export type ExifInfo = {
  hasExif: boolean;
  make: string | null;
  model: string | null;
  software: string | null;
  dateTimeOriginal: string | null;
};

const EMPTY: ExifInfo = {
  hasExif: false,
  make: null,
  model: null,
  software: null,
  dateTimeOriginal: null,
};

const TAGS: Record<number, keyof ExifInfo> = {
  0x010f: "make",
  0x0110: "model",
  0x0131: "software",
  0x9003: "dateTimeOriginal",
};

export function readExif(bytes: Uint8Array): ExifInfo {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return EMPTY; // not a JPEG => no EXIF
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xda) break; // start of scan; metadata segments are done
    const size = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (marker === 0xe1) {
      const header = String.fromCharCode(...bytes.slice(offset + 4, offset + 10));
      if (header.startsWith("Exif")) {
        return parseTiff(bytes, offset + 10) ?? { ...EMPTY, hasExif: true };
      }
    }
    offset += 2 + size;
  }
  return EMPTY;
}

function parseTiff(bytes: Uint8Array, start: number): ExifInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (start + 8 > bytes.length) return null;
  const byteOrder = view.getUint16(start);
  const little = byteOrder === 0x4949;
  if (!little && byteOrder !== 0x4d4d) return null;
  const result: ExifInfo = { ...EMPTY, hasExif: true };
  const ifd0 = start + view.getUint32(start + 4, little);
  const exifIfdPointer = readIfd(view, bytes, start, ifd0, little, result);
  if (exifIfdPointer) readIfd(view, bytes, start, start + exifIfdPointer, little, result);
  return result;
}

function readIfd(
  view: DataView,
  bytes: Uint8Array,
  tiffStart: number,
  ifdStart: number,
  little: boolean,
  out: ExifInfo,
): number | null {
  if (ifdStart + 2 > bytes.length) return null;
  const count = view.getUint16(ifdStart, little);
  let subIfd: number | null = null;
  for (let i = 0; i < count; i++) {
    const entry = ifdStart + 2 + i * 12;
    if (entry + 12 > bytes.length) break;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const length = view.getUint32(entry + 4, little);
    if (tag === 0x8769) {
      subIfd = view.getUint32(entry + 8, little);
      continue;
    }
    const field = TAGS[tag];
    if (!field || type !== 2) continue;
    const valueOffset =
      length <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, little);
    if (valueOffset + length > bytes.length) continue;
    const text = String.fromCharCode(...bytes.slice(valueOffset, valueOffset + length))
      .replace(/\0+$/, "")
      .trim();
    if (text) (out as Record<string, unknown>)[field] = text;
  }
  return subIfd;
}