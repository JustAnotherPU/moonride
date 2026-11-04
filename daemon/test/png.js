'use strict';
// Self-test of png.js: PNGs made here (every filter, grey / RGB / RGBA / palette, 8 and 16 bits) decoded back,
// and fit()'s crop and averaging. Optional: a real cover (Vibepollo's 600x900 box art) as the argument.
//   node test/png.js [cover.png]
const assert = require('assert');
const fs = require('fs');
const zlib = require('zlib');
const { decode, fit } = require('../png');

function chunk(type, data) {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
}
// rows: unfiltered scanlines (Buffers); each one filtered with filters[y % n] (the encoder's side of PNG's filters)
function encode(w, h, bd, ct, rows, filters, extra) {
    const bpp = Math.max(1, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[ct] * bd >> 3);
    const out = [];
    rows.forEach((r, y) => {
        const p = y ? rows[y - 1] : Buffer.alloc(r.length), f = filters[y % filters.length], o = Buffer.alloc(r.length + 1);
        o[0] = f;
        for (let x = 0; x < r.length; x++) {
            const a = x >= bpp ? r[x - bpp] : 0, b = p[x], c = x >= bpp ? p[x - bpp] : 0;
            const pr = a + b - c, pa = Math.abs(pr - a), pb = Math.abs(pr - b), pc = Math.abs(pr - c);
            const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
            o[x + 1] = (r[x] - pred) & 255;
        }
        out.push(o);
    });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = bd; ihdr[9] = ct;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)].concat(extra || [])
        .concat([chunk('IDAT', zlib.deflateSync(Buffer.concat(out))), chunk('IEND', Buffer.alloc(0))]));
}
const W = 7, H = 10, ALL = [0, 1, 2, 3, 4];
const px = (x, y) => [(x * 37 + y * 11) & 255, (x * 5 + y * 71 + 9) & 255, (x * 113 + y * 3 + 200) & 255];

// RGB 8 bits, every filter
let rows = [];
for (let y = 0; y < H; y++) { const r = Buffer.alloc(W * 3); for (let x = 0; x < W; x++) Buffer.from(px(x, y)).copy(r, x * 3); rows.push(r); }
let img = decode(encode(W, H, 8, 2, rows, ALL));
assert.deepStrictEqual([img.w, img.h], [W, H]);
assert.ok(img.rgb.equals(Buffer.concat(rows)), 'RGB 8, filters 0-4');

// RGBA 8 bits: alpha over black
rows = [];
for (let y = 0; y < H; y++) { const r = Buffer.alloc(W * 4); for (let x = 0; x < W; x++) { Buffer.from(px(x, y)).copy(r, x * 4); r[x * 4 + 3] = x === 0 ? 0 : x === 1 ? 128 : 255; } rows.push(r); }
img = decode(encode(W, H, 8, 6, rows, [4, 3, 1]));
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const want = px(x, y).map((c) => (x === 0 ? 0 : x === 1 ? Math.floor((c * 128 + 127) / 255) : c));
        assert.deepStrictEqual(Array.from(img.rgb.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)), want, 'RGBA at ' + x + ',' + y);
    }
}

// RGB 16 bits: the high bytes
rows = [];
for (let y = 0; y < H; y++) { const r = Buffer.alloc(W * 6); for (let x = 0; x < W; x++) px(x, y).forEach((c, k) => { r[x * 6 + k * 2] = c; r[x * 6 + k * 2 + 1] = 0x5a; }); rows.push(r); }
img = decode(encode(W, H, 16, 2, rows, ALL));
for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0; assert.deepStrictEqual(Array.from(img.rgb.subarray(i * 3, i * 3 + 3)), px(x, y), 'RGB 16'); }

// grey 8 bits and grey + alpha
rows = []; for (let y = 0; y < H; y++) rows.push(Buffer.from(Array.from({ length: W }, (_, x) => x * 30 + y)));
img = decode(encode(W, H, 8, 0, rows, ALL));
assert.strictEqual(img.rgb[(3 * W + 2) * 3 + 1], 63, 'grey');
rows = []; for (let y = 0; y < H; y++) rows.push(Buffer.from([].concat.apply([], Array.from({ length: W }, (_, x) => [200, x ? 255 : 0]))));
img = decode(encode(W, H, 8, 4, rows, [2]));
assert.deepStrictEqual(Array.from(img.rgb.subarray(0, 6)), [0, 0, 0, 200, 200, 200], 'grey + alpha');

// palette, 8 and 2 bits, with tRNS
const pal = chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30])), trns = chunk('tRNS', Buffer.from([255, 0]));
rows = []; for (let y = 0; y < H; y++) rows.push(Buffer.from(Array.from({ length: W }, (_, x) => (x + y) & 3)));
img = decode(encode(W, H, 8, 3, rows, ALL, [pal, trns]));
assert.deepStrictEqual(Array.from(img.rgb.subarray(0, 12)), [255, 0, 0, 0, 0, 0, 0, 0, 255, 10, 20, 30], 'palette 8 bits (index 1 transparent)');
rows = []; for (let y = 0; y < H; y++) { const r = Buffer.alloc(2); for (let x = 0; x < W; x++) r[x >> 2] |= ((x + y) & 3) << (6 - 2 * (x & 3)); rows.push(r); }
img = decode(encode(W, H, 2, 3, rows, ALL, [pal]));
for (let x = 0; x < W; x++) assert.deepStrictEqual(Array.from(img.rgb.subarray(x * 3, x * 3 + 3)), [[255, 0, 0], [0, 255, 0], [0, 0, 255], [10, 20, 30]][x & 3], 'palette 2 bits at ' + x);

// refused: not a PNG, interlaced
assert.throws(() => decode(Buffer.from('GIF89a................................')), /not a PNG/);
const il = encode(W, H, 8, 2, [Buffer.alloc(W * 3)], [0]); il[8 + 8 + 12] = 1;
assert.throws(() => decode(il), /interlaced/);

// fit: a 6 x 2 image, left half black and right white, to 1 x 2 (the centre 1:2 column, x 1.5..2.5 -> 2..3) and 2 x 2
const half = { w: 6, h: 2, rgb: Buffer.from([].concat.apply([], Array.from({ length: 12 }, (_, i) => (i % 6 < 3 ? [0, 0, 0] : [255, 255, 255])))) };
const f1 = fit(half, 1, 2);
assert.strictEqual(f1.length, 1 * 2 * 4);
assert.deepStrictEqual(Array.from(f1.subarray(0, 4)), [0, 0, 0, 255], 'crop to the centre (x 2)');
const f2 = fit(half, 2, 2);   // crop 2 wide: x 2..3 -> one black, one white
assert.deepStrictEqual(Array.from(f2.subarray(0, 8)), [0, 0, 0, 255, 255, 255, 255, 255], 'crop + 1:1');
const avg = fit({ w: 4, h: 4, rgb: Buffer.from([].concat.apply([], Array.from({ length: 16 }, (_, i) => (i % 2 ? [100, 100, 100] : [200, 200, 200])))) }, 2, 2);
assert.deepStrictEqual(Array.from(avg.subarray(0, 4)), [150, 150, 150, 255], 'box average');
const up = fit({ w: 1, h: 1, rgb: Buffer.from([1, 2, 3]) }, 3, 3);
assert.deepStrictEqual(Array.from(up.subarray(16, 20)), [1, 2, 3, 255], 'stretch up');

// a real cover, timed (the car's Atom is a few times slower)
if (process.argv[2]) {
    const t0 = process.hrtime.bigint(), real = decode(fs.readFileSync(process.argv[2]));
    const t1 = process.hrtime.bigint(), c = fit(real, 252, 378), t2 = process.hrtime.bigint();
    assert.ok(real.w > 0 && c.length === 252 * 378 * 4);
    console.log('cover ' + real.w + 'x' + real.h + ': decode ' + Number(t1 - t0) / 1e6 + ' ms, fit ' + Number(t2 - t1) / 1e6 + ' ms');
}
console.log('png: all checks passed (' + process.version + ')');
