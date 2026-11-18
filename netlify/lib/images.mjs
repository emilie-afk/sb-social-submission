// Screenshot payload validation — runs before any call to Claude.
// Netlify synchronous functions accept request bodies up to 6 MB; Claude accepts
// images up to 5 MB each. The browser re-encodes photos to JPEG ≤ 1200 px first.

export const IMAGE_LIMITS = {
  maxImages: 10,
  maxBodyBytes: 5_900_000,          // under Netlify's 6 MB request limit
  maxImageBytes: 3_500_000,         // decoded, per image
  maxTotalBytes: 4_300_000,         // decoded, all images
  minImageBytes: 32,
};

const TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => ['GIF87a', 'GIF89a'].includes(b.slice(0, 6).toString('latin1')),
  'image/webp': (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
};

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Returns { ok:true, images:[{mediaType, data}] } or { ok:false, message }. */
export function validateImages(payload) {
  const list = payload && payload.images;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, message: 'No images provided.' };
  if (list.length > IMAGE_LIMITS.maxImages) {
    return { ok: false, message: `Up to ${IMAGE_LIMITS.maxImages} screenshots per extraction.` };
  }
  let total = 0;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    const n = i + 1;
    if (!img || typeof img !== 'object') return { ok: false, message: `Screenshot ${n} is invalid.` };
    const mediaType = String(img.mimeType || '').toLowerCase();
    if (!TYPES[mediaType]) return { ok: false, message: `Screenshot ${n}: use JPEG, PNG, WebP or GIF.` };
    const data = img.base64;
    if (typeof data !== 'string' || data.length % 4 !== 0 || !B64.test(data)) {
      return { ok: false, message: `Screenshot ${n} could not be read.` };
    }
    const bytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes < IMAGE_LIMITS.minImageBytes) return { ok: false, message: `Screenshot ${n} could not be read.` };
    if (bytes > IMAGE_LIMITS.maxImageBytes) return { ok: false, message: `Screenshot ${n} is too large.` };
    total += bytes;
    if (total > IMAGE_LIMITS.maxTotalBytes) {
      return { ok: false, message: 'The screenshots are too large together — remove a few and try again.' };
    }
    const head = Buffer.from(data.slice(0, 24), 'base64');
    if (!TYPES[mediaType](head)) return { ok: false, message: `Screenshot ${n} is not a valid ${mediaType.slice(6).toUpperCase()} image.` };
    out.push({ mediaType, data });
  }
  return { ok: true, images: out };
}
