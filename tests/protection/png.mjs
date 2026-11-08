import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';

// Only the lossless 8-bit RGB/RGBA PNGs emitted by WebView2 Page.captureScreenshot.
export function decodePng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let width, height, channels; const parts = [];
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8), data = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.ok([2, 6].includes(data[9])); assert.equal(data[12], 0); channels = data[9] === 6 ? 4 : 3; }
    if (type === 'IDAT') parts.push(data);
    at += size + 12;
  }
  const raw = inflateSync(Buffer.concat(parts)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  assert.equal(raw.length, (stride + 1) * height);
  const paeth = (a, b, c) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? pixels[at - channels] : 0,
        b = y ? pixels[at - stride] : 0, c = y && x >= channels ? pixels[at - stride - channels] : 0;
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      pixels[at] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return { width, height, channels, pixels };
}
export function comparePng(actualBytes, expectedBytes, tolerance = 12, maximumRatio = 0.005) {
  const a = decodePng(actualBytes), b = decodePng(expectedBytes);
  assert.equal(a.width, b.width, 'screenshot width'); assert.equal(a.height, b.height, 'screenshot height');
  let changed = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    if ([0, 1, 2].some(c => Math.abs(a.pixels[i * a.channels + c] - b.pixels[i * b.channels + c]) > tolerance)) changed++;
  }
  const ratio = changed / (a.width * a.height);
  assert.ok(ratio <= maximumRatio, `screenshot changed ${(ratio * 100).toFixed(2)}% > ${maximumRatio * 100}%; inspect actual and expected, do not auto-update baseline`);
  return { changedPixels: changed, ratio, tolerance, maximumRatio };
}
