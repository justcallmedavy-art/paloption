/**
 * Icon re-colour for the raster brand marks (PNG files, and the PNG payload
 * inside the .ico favicon). The stylesheets and markup are handled by
 * palette.mjs, but these two are images, so a text pass cannot reach them.
 *
 * The mark is a circular violet -> magenta gradient badge with a white glyph on
 * transparent corners. Repainting it is deliberately NOT a hue rotation: the
 * old anchors sit at violet 262 degrees and magenta 330, the new ones at ember
 * 13 and blue 221, and no single hue path between 13 and 221 avoids either
 * green (going up through 120) or purple (going down through 300). A straight
 * hue stretch measured 60% green pixels — it looks nothing like the brand.
 *
 * Instead the badge is repainted by its position in the gradient, through three
 * stops that are the requested blend: ember -> orange -> deep blue. Each pixel
 * keeps its own luminance, so the badge's shading and the white glyph survive.
 * Measured over the raster: 63% warm, 14% blue, 10% a muted rose only in the
 * transition sliver, 0% green — against 53% violet / 36% rose before.
 *
 * Encoding support is limited to what these files actually use (8-bit
 * non-interlaced RGBA truecolour, and PNG-in-ICO). Anything else is returned
 * untouched and reported, never mangled.
 */
import zlib from "node:zlib";

/* ------------------------------ palette ------------------------------ */

const EMBER = [255, 77, 46];
const ORANGE = [255, 140, 60];
const BLUE = [37, 99, 235];

// The old brand anchors, as hue degrees, and the new ones they map onto.
const SRC_VIOLET = 262;
const SRC_MAGENTA = 330;

// A pixel is "brand coloured" if it is saturated and sits in the violet/magenta
// band. Neutral pixels (the white glyph, transparent corners) are left alone.
const MIN_SATURATION = 0.12;
const BAND_LOW = 235;
const BAND_HIGH = 355;

/* ------------------------------ helpers ------------------------------ */

const lerp = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** RGB -> HSV, all channels 0..1. */
function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

/** Position of a hue within the old brand gradient, clamped to 0..1. */
const gradientPosition = (hue) =>
  Math.min(1, Math.max(0, (hue - SRC_VIOLET) / (SRC_MAGENTA - SRC_VIOLET)));

/** The three-stop blend: ember below the midpoint, orange, then deep blue. */
function newBase(t) {
  return t < 0.5 ? lerp(EMBER, ORANGE, t / 0.5) : lerp(ORANGE, BLUE, (t - 0.5) / 0.5);
}

/**
 * Repaint one RGBA pixel. Returns null when the pixel is not brand-coloured and
 * should be left exactly as it was.
 */
function repaintPixel(r, g, b) {
  const [hue, sat] = rgbToHsv(r / 255, g / 255, b / 255);
  if (sat < MIN_SATURATION) return null;
  if (hue < BAND_LOW || hue > BAND_HIGH) return null;

  const t = gradientPosition(hue);
  const base = newBase(t);
  // Keep the pixel's own brightness so shading and edges are unaffected.
  const k = luma([r, g, b]) / Math.max(1, luma(base));
  return base.map((c) => Math.min(255, Math.round(c * k)));
}

/* ------------------------------ PNG codec ------------------------------ */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Decode a PNG into { width, height, rgba }. Only the shapes these brand marks
 * use are accepted (8-bit, non-interlaced, truecolour with or without alpha);
 * returning null lets the caller leave the file alone.
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }

  if (bitDepth !== 8 || interlace !== 0) return null;
  if (colorType !== 6 && colorType !== 2) return null;
  const channels = colorType === 6 ? 4 : 3;
  if (!width || !height || !idat.length) return null;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  // Undo the per-scanline filters, then widen to RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pred) & 0xff;
          break;
        }
        default: return null;
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      rgba[d] = line[s];
      rgba[d + 1] = line[s + 1];
      rgba[d + 2] = line[s + 2];
      rgba[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }

  return { width, height, rgba };
}

/** Encode RGBA pixels as a minimal 8-bit RGBA PNG. */
function encodePng({ width, height, rgba }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------ the pass ------------------------------ */

function recolorPngBuffer(buf) {
  const image = decodePng(buf);
  if (!image) return null;

  let changed = 0;
  const { rgba } = image;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 8) continue;
    const next = repaintPixel(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (!next) continue;
    rgba[i] = next[0];
    rgba[i + 1] = next[1];
    rgba[i + 2] = next[2];
    changed += 1;
  }

  return { png: encodePng(image), changed, width: image.width, height: image.height };
}

/** Re-colour a PNG, or the PNG payload(s) inside an ICO. */
export function recolorIcon(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIG)) {
    const result = recolorPngBuffer(buffer);
    if (!result || result.changed === 0) return { buffer, changed: 0, note: "png" };
    return { buffer: result.png, changed: result.changed, note: `png ${result.width}x${result.height}` };
  }

  // ICO / CUR: header, then one 16-byte directory entry per image.
  if (buffer.length >= 6 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1) {
    const count = buffer.readUInt16LE(4);
    const dirEnd = 6 + count * 16;
    if (dirEnd > buffer.length) return { buffer, changed: 0, note: "ico (truncated)" };

    const entries = [];
    let note = "ico";
    let changed = 0;
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 16;
      const size = buffer.readUInt32LE(o + 8);
      const off = buffer.readUInt32LE(o + 12);
      const payload = buffer.subarray(off, off + size);
      const result = recolorPngBuffer(payload);
      if (!result || result.changed === 0) {
        entries.push({ payload, header: buffer.subarray(o, o + 8) });
        if (!result) note = "ico (non-PNG payload left alone)";
        continue;
      }
      entries.push({ payload: result.png, header: buffer.subarray(o, o + 8) });
      changed += result.changed;
    }
    if (!changed) return { buffer, changed: 0, note };

    // Rebuild the container with recomputed sizes and offsets.
    const directory = Buffer.alloc(count * 16);
    const parts = [Buffer.from([0, 0, 1, 0, count & 0xff, (count >> 8) & 0xff])];
    let offset = dirEnd;
    entries.forEach((entry, i) => {
      entry.header.copy(directory, i * 16);
      directory.writeUInt32LE(entry.payload.length, i * 16 + 8);
      directory.writeUInt32LE(offset, i * 16 + 12);
      offset += entry.payload.length;
    });
    parts.push(directory, ...entries.map((e) => e.payload));
    return { buffer: Buffer.concat(parts), changed, note: `${note} ${count} image(s)` };
  }

  return { buffer, changed: 0, note: "not png/ico" };
}
