'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * png.js - just enough PNG for the hosts' box art (Node 22, built-ins only), and the cover the app draws.
 *
 *   decode(buf)       -> { w, h, rgb }   8 or 16 bits, grey / RGB / palette (1..8 bits) / grey+alpha / RGBA,
 *                                        every filter; alpha is laid over black (the cover is opaque)
 *   fit(img, W, H)    -> Buffer W*H*4    RGBA, opaque: cropped to fill W x H (centred), box-averaged
 *
 * Interlaced PNGs throw (Vibepollo's covers are not). The chunks' CRCs are not checked: TLS did that.
 */
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_PX = 4096 * 4096;

function decode(buf) {
    if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
    let w = 0, h = 0, bd = 0, ct = 0, il = 0, pal = null, trns = null;
    const idat = [];
    for (let i = 8; i + 8 <= buf.length;) {
        const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8), d = buf.subarray(i + 8, i + 8 + len);
        if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; il = d[12]; } else if (type === 'PLTE') pal = d;
        else if (type === 'tRNS') trns = d;
        else if (type === 'IDAT') idat.push(d);
        else if (type === 'IEND') break;
        i += 12 + len;
    }
    const ch = CHANNELS[ct];
    if (!ch || !(w > 0 && h > 0 && w * h <= MAX_PX)) throw new Error('PNG: unsupported (colour type ' + ct + ', ' + w + 'x' + h + ')');
    if (il) throw new Error('PNG: interlaced');
    if (!(bd === 8 || (bd === 16 && ct !== 3) || (bd < 8 && (ct === 0 || ct === 3) && [1, 2, 4].indexOf(bd) >= 0))) throw new Error('PNG: bit depth ' + bd);
    if (ct === 3 && !pal) throw new Error('PNG: no palette');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = Math.max(1, ch * bd >> 3), stride = (w * ch * bd + 7) >> 3;
    if (raw.length < h * (stride + 1)) throw new Error('PNG: short image data');

    // unfilter in place (each row: its filter byte, then stride bytes)
    let prev = null;
    for (let y = 0; y < h; y++) {
        const o = y * (stride + 1) + 1, f = raw[o - 1], po = o - stride - 1;
        if (f > 4) throw new Error('PNG: filter ' + f);
        for (let x = 0; f && x < stride; x++) {
            const a = x >= bpp ? raw[o + x - bpp] : 0, b = prev ? raw[po + x] : 0, c = prev && x >= bpp ? raw[po + x - bpp] : 0;
            let v;
            if (f === 1) v = a;
            else if (f === 2) v = b;
            else if (f === 3) v = (a + b) >> 1;
            else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            raw[o + x] = (raw[o + x] + v) & 255;
        }
        prev = true;
    }

    // samples -> RGB over black (16 bits: the high byte)
    const rgb = Buffer.allocUnsafe(w * h * 3), step = bd >> 3, mask = (1 << bd) - 1;
    const tr = trns && ct === 0 && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
    const trRGB = trns && ct === 2 && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
    for (let y = 0; y < h; y++) {
        const o = y * (stride + 1) + 1;
        for (let x = 0; x < w; x++) {
            let r, g, b, al = 255;
            if (bd < 8) {
                const bit = x * bd, v = (raw[o + (bit >> 3)] >> (8 - bd - (bit & 7))) & mask;
                if (ct === 3) { r = pal[v * 3] | 0; g = pal[v * 3 + 1] | 0; b = pal[v * 3 + 2] | 0; if (trns && v < trns.length) al = trns[v]; } else { r = g = b = Math.round(v * 255 / mask); if (v === tr) al = 0; }
            } else {
                const s = o + x * ch * step;
                if (ct === 3) { const v = raw[s]; r = pal[v * 3] | 0; g = pal[v * 3 + 1] | 0; b = pal[v * 3 + 2] | 0; if (trns && v < trns.length) al = trns[v]; } else if (ct === 0 || ct === 4) {
                    r = g = b = raw[s];
                    if (ct === 4) al = raw[s + step];
                    else if (tr >= 0 && (step === 2 ? raw.readUInt16BE(s) : raw[s]) === tr) al = 0;
                } else {
                    r = raw[s]; g = raw[s + step]; b = raw[s + 2 * step];
                    if (ct === 6) al = raw[s + 3 * step];
                    else if (trRGB && (step === 2 ? [raw.readUInt16BE(s), raw.readUInt16BE(s + 2), raw.readUInt16BE(s + 4)] : [r, g, b]).every((q, k) => q === trRGB[k])) al = 0;
                }
            }
            const d = (y * w + x) * 3;
            if (al === 255) { rgb[d] = r; rgb[d + 1] = g; rgb[d + 2] = b; } else { rgb[d] = (r * al + 127) / 255 | 0; rgb[d + 1] = (g * al + 127) / 255 | 0; rgb[d + 2] = (b * al + 127) / 255 | 0; }
        }
    }
    return { w, h, rgb };
}

/** The part of img with W:H's shape (centred), averaged down (or stretched up) to W x H, as opaque RGBA. */
function fit(img, W, H) {
    const { w, h, rgb } = img;
    let cw = w, chh = h;
    if (w * H > h * W) cw = Math.max(1, Math.round(h * W / H)); else chh = Math.max(1, Math.round(w * H / W));
    const x0 = (w - cw) >> 1, y0 = (h - chh) >> 1;
    // each output pixel averages the source pixels [a, b) under it, at least one
    const span = (n, N, off) => {
        const a = new Int32Array(N), b = new Int32Array(N);
        for (let i = 0; i < N; i++) { a[i] = off + Math.min(n - 1, Math.floor(i * n / N)); b[i] = Math.max(a[i] + 1, off + Math.floor((i + 1) * n / N)); }
        return [a, b];
    };
    const [xa, xb] = span(cw, W, x0), [ya, yb] = span(chh, H, y0);
    const out = Buffer.allocUnsafe(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let r = 0, g = 0, b = 0;
            for (let sy = ya[y]; sy < yb[y]; sy++) {
                for (let s = (sy * w + xa[x]) * 3, e = (sy * w + xb[x]) * 3; s < e; s += 3) { r += rgb[s]; g += rgb[s + 1]; b += rgb[s + 2]; }
            }
            const n = (yb[y] - ya[y]) * (xb[x] - xa[x]), d = (y * W + x) * 4;
            out[d] = (r + (n >> 1)) / n | 0; out[d + 1] = (g + (n >> 1)) / n | 0; out[d + 2] = (b + (n >> 1)) / n | 0; out[d + 3] = 255;
        }
    }
    return out;
}

module.exports = { decode, fit };
