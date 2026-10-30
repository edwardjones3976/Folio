// Generates icons/icon-{16,32,48,128}.png (an open book on a dark square).
// Dependency-free PNG encoder; run with: node src/tools/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKGROUND = [0x4a, 0x2c, 0x17, 255];
const PAGE = [0xfb, 0xf4, 0xe6, 255];
const LINE = [0xb0, 0x8a, 0x5c, 255];
const CLEAR = [0, 0, 0, 0];

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function pixel(size, x, y) {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;
  const r = 0.18;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return CLEAR;
  const inLeft = u > 0.17 && u < 0.48 && v > 0.24 && v < 0.78;
  const inRight = u > 0.52 && u < 0.83 && v > 0.24 && v < 0.78;
  if (inLeft || inRight) {
    const local = inLeft ? (u - 0.17) / 0.31 : (u - 0.52) / 0.31;
    const ruled = size >= 32 && local > 0.15 && local < 0.85 && [0.38, 0.5, 0.62].some((l) => Math.abs(v - l) < 0.5 / size);
    return ruled ? LINE : PAGE;
  }
  return BACKGROUND;
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      Buffer.from(pixel(size, x, y)).copy(raw, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(join(ROOT, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(ROOT, 'icons', `icon-${size}.png`), png(size));
}
console.log('icons written');
