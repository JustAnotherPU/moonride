'use strict';
/**
 * view.js - the drawn MAIN screen (an iOS-like look), on the
 * kit's drawing surface (ctx.canvas: a record.js Recorder, played into a PNG where the HMI shows it).
 *
 *   draw(cv, m)   one frame of the page m.mode ('home' | 'pads'), with the pairing sheet over home while
 *                 the daemon waits for its PIN. Pressable things are cv.target()s (key: see below); where
 *                 the kit runs the screen it rings the one the controller is on, elsewhere (m.ring) we do.
 *
 * m (built by main.js each frame): { mode, st, pads, padRows, focus, ring, first, padSy, extra, host, res,
 *   parkedOnly, driving, live, chrome, pic(app) -> picture id of its cover or null,
 *   act: { start(app), pair(), refresh(), stop(), menu(), pads(), close(), settings(), scan(), pad(row) } }
 * Keys: app:<id>, pair, refresh, stop, menu, pads, settings (home; pads and settings with the menu open); close, scan, pad:<addr>, pair:<addr> (pads).
 *
 *   stats(cv, s)  GAME's performance overlay (as Moonlight's), top left over the video: s = the stream's last
 *                 {"ev":"stats"} (main.cpp stats_loop, one second's worth). Drawn only, no targets: touch stays the game's.
 *
 * The page is 1600 x 520 but where the kit runs the screen only y 38.. and x 12..1588 show (display.js
 * FULL.src), so nothing sits above TOP. Text is French and literal (no kit i18n).
 */
const qr = require('./kit/qr');
const W = 1600, H = 520, TOP = 38;
// the home row: cards portrait 2:3, as the hosts' box art. On the whole screen ("fill" in app.json: no header, the
// page from the top, 80 more px below its 520: m.extra) they are bigger, as moonlightd.js caches the art (x 1.2)
const SMALL = { pillY: 58, footY: 452, clipX: 12, card: { x: 40, y: 119, w: 210, h: 315, r: 24, gap: 24, focus: 1.07 } };
const BIG = { pillY: 24, footY: 548, clipX: 0, card: { x: 40, y: 92, w: 300, h: 450, r: 28, gap: 24, focus: 1.05 } };
let L, CARD, PITCH, SHOWN;                              // SHOWN whole cards, the next one peeking at the right
function layout(extra) {
    L = extra >= 60 ? BIG : SMALL;
    CARD = L.card, PITCH = CARD.w + CARD.gap, SHOWN = Math.floor((W - CARD.x) / PITCH);
}
layout(0);
const ACTION_W = 160;                                   // the row's end cards (Actualiser, Jumeler)
const LIT = { literal: true }, BOLD = { literal: true, font: 'bold' };
const C = { text: '#ffffff', dim: '#ffffffa6', dim2: '#ffffffc8', faint: '#ffffff66', glass: '#ffffff17', glass2: '#ffffff26', green: '#30d158',
    orange: '#ff9f0a', red: '#ff453a', blue: '#0a84ff', link: '#5ac8fa', sheet: '#23262e', box: '#343842' };
// card colours, top and bottom of the gradient: picked by the title, so an app keeps its colour
const PALETTE = [['#2563eb', '#0b1d6b'], ['#335a7a', '#152a40'], ['#b5452b', '#2a1210'], ['#c9a35e', '#4a2f17'],
    ['#2a7a4a', '#0e2a1a'], ['#7b3fc4', '#251040'], ['#c23a5c', '#3a0f1e'], ['#1f8a9a', '#0c2a33']];

// FNV-1a, mixed at the end: similar titles still spread over the palette
function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
    return h >>> 0;
}
/** s cut with an ellipsis to w px */
function fit(cv, s, size, w, opts) {
    s = String(s || '');
    if (cv.textWidth(s, size, opts) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const k = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, k) + '…', size, opts) <= w) lo = k; else hi = k - 1; }
    return s.slice(0, lo).replace(/\s+$/, '') + '…';     // (no trimEnd on Node 8)
}
/** s in at most two lines of w px (cut between words, the second ellipsised) */
function wrap2(cv, s, size, w, opts) {
    if (cv.textWidth(s, size, opts) <= w) return [s];
    const words = s.split(/\s+/);
    let l1 = words[0], i = 1;
    for (; i < words.length && cv.textWidth(l1 + ' ' + words[i], size, opts) <= w; i++) l1 += ' ' + words[i];
    if (i === words.length || cv.textWidth(l1, size, opts) > w) return [fit(cv, s, size, w, opts)];
    return [l1, fit(cv, words.slice(i).join(' '), size, w, opts)];
}
const tri = (cv, pts, c) => cv.quad([pts[0], pts[1], pts[2], pts[0]], c);

/* ---------- icons (vector: the mockups' emoji are placeholders) ---------- */
function gear(cv, x, y, s, c) {
    for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a), w = s * 0.17, r0 = s * 0.55, r1 = s * 0.95;
        cv.quad([[x + ca * r0 - sa * w, y + sa * r0 + ca * w], [x + ca * r1 - sa * w, y + sa * r1 + ca * w],
            [x + ca * r1 + sa * w, y + sa * r1 - ca * w], [x + ca * r0 + sa * w, y + sa * r0 - ca * w]], c);
    }
    cv.arc(x, y, s * 0.32, s * 0.72, 0, 360, c);
}
function pad(cv, x, y, s, c, bg) {
    cv.roundRect(x - s, y - s * 0.5, 2 * s, s, s * 0.45, c);
    cv.circle(x - s * 0.62, y + s * 0.38, s * 0.42, c); cv.circle(x + s * 0.62, y + s * 0.38, s * 0.42, c);
    cv.fillRect(x - s * 0.72, y - s * 0.07, s * 0.44, s * 0.14, bg); cv.fillRect(x - s * 0.57, y - s * 0.22, s * 0.14, s * 0.44, bg);
    cv.circle(x + s * 0.42, y - s * 0.12, s * 0.1, bg); cv.circle(x + s * 0.62, y + s * 0.08, s * 0.1, bg);
}
function monitor(cv, x, y, s, c, bg) {
    cv.roundRect(x - s, y - s * 0.7, 2 * s, s * 1.25, s * 0.12, c);
    cv.roundRect(x - s * 0.86, y - s * 0.57, s * 1.72, s * 0.95, s * 0.06, bg);
    cv.fillRect(x - s * 0.12, y + s * 0.55, s * 0.24, s * 0.25, c);
    cv.roundRect(x - s * 0.42, y + s * 0.78, s * 0.84, s * 0.12, s * 0.06, c);
}
function refreshIcon(cv, x, y, s, c) {
    cv.arc(x, y, s * 0.62, s * 0.86, 40, 340, c);
    tri(cv, [[x - s * 0.05, y - s * 1.12], [x + s * 0.42, y - s * 0.74], [x - s * 0.05, y - s * 0.38]], c);
}
function plus(cv, x, y, s, c) { cv.line(x - s, y, x + s, y, s * 0.28, c); cv.line(x, y - s, x, y + s, s * 0.28, c); }
function cross(cv, x, y, s, c) { cv.line(x - s, y - s, x + s, y + s, s * 0.26, c); cv.line(x - s, y + s, x + s, y - s, s * 0.26, c); }
function usb(cv, x, y, s, c) {
    cv.line(x, y - s * 0.7, x, y + s * 0.75, s * 0.16, c);
    tri(cv, [[x, y - s], [x + s * 0.24, y - s * 0.6], [x - s * 0.24, y - s * 0.6]], c);
    cv.circle(x, y + s * 0.8, s * 0.2, c);
    cv.polyline([[x, y + s * 0.3], [x - s * 0.45, y], [x - s * 0.45, y - s * 0.3]], s * 0.14, c);
    cv.polyline([[x, y + s * 0.1], [x + s * 0.45, y - s * 0.15], [x + s * 0.45, y - s * 0.4]], s * 0.14, c);
    cv.fillRect(x + s * 0.33, y - s * 0.55, s * 0.24, s * 0.2, c);
}
function battery(cv, x, y, pct, c) {      // x, y: top left of a 38 x 18 body
    cv.strokeRoundRect(x, y, 38, 18, 5, 2, '#ffffffb0');
    cv.roundRect(x + 40, y + 6, 3, 6, 1.5, '#ffffffb0');
    cv.roundRect(x + 3, y + 3, Math.max(2, 32 * Math.max(0, Math.min(100, pct)) / 100), 12, 3, c);
}
function spinner(cv, x, y, r) { cv.arc(x, y, r - 3, r, 0, 360, '#ffffff33'); cv.arc(x, y, r - 3, r, 0, 100, '#ffffffcc', { round: true }); }

/* ---------- pieces ---------- */
function background(cv, h) {
    // the mockups' radial glow: a vertical fall to black, darker again towards the left
    cv.gradientRect(0, 0, W, h, [[0, '#16233f'], [0.55, '#080d1a'], [1, '#030409']]);
    cv.rampRect(0, 0, W, h, 0, ['#000000a0', '#00000040', '#00000000']);
}
/** pill with a coloured dot (or none), text; returns its right edge */
function pill(cv, x, y, text, dot, h) {
    h = h || 44;
    const tw = cv.textWidth(text, 22, BOLD), w = tw + (dot ? 54 : 36);
    cv.roundRect(x, y, w, h, h / 2, C.glass);
    if (dot) cv.circle(x + 22, y + h / 2, 6, dot);
    cv.text(text, x + (dot ? 36 : 18), y + h / 2 + 8, 22, C.text, BOLD);
    return x + w;
}
/** a ring round x, y, w, h as the kit draws it where it runs the screen (display.js _drawChrome) */
function ring(cv, m, key, x, y, w, h, r) { if (m.ring && m.focus === key) cv.strokeRoundRect(x - 5, y - 5, w + 10, h + 10, r + 5, 3, '#ffffff'); }

function appCard(cv, m, a, x, focused) {
    // "Clair Obscur: Expedition 33" -> the title and, under it, the rest (as the mockups' subtitles)
    const full = String(a.title || 'App ' + a.id), cut = full.search(/: | - /);
    const title = cut > 0 ? full.slice(0, cut) : full, rest = cut > 0 ? full.slice(cut + 2).trim() : null;
    const col = PALETTE[hash(title) % PALETTE.length];
    const k = focused ? CARD.focus : 1, w = CARD.w * k, h = CARD.h * k, r = CARD.r * k;
    const cx = x - (w - CARD.w) / 2, cy = CARD.y - (h - CARD.h) / 2;
    // the gradient: the card without a cover (or until it is read), under the cover otherwise
    cv.card(cx, cy, w, h, r, [[0, col[0]], [1, col[1]]]);
    const pid = m.pic ? m.pic(a) : null;
    // shortcut: square corners on the software path (canvas.js images have no radius), the HMI's PNG only
    if (pid) { if (cv.place) cv.picture(pid, cx, cy, w, h, r); else cv.image(pid, cx, cy, w, h); }
    // the title's fade: stronger over a cover (box art is busy at the bottom)
    cv.card(cx, cy + h * 0.45, w, h * 0.55, r, pid ? [[0, '#00000000'], [0.45, '#000000a0'], [1, '#000000e6']] : [[0, '#00000000'], [1, '#000000b8']]);
    if (!pid && /desktop|bureau/i.test(title)) monitor(cv, cx + 56, cy + 58, 28 * k, '#e8eef8', col[0]);
    else if (!pid && /steam|big picture/i.test(title)) pad(cv, cx + 58, cy + 60, 28 * k, '#e8eef8', col[0]);
    // the title in up to two lines (the cards are narrow), the rest or the stream mode under it
    const tx = cx + 16 * k, tw = w - 32 * k, sub = rest || (focused ? m.res : null), lines = wrap2(cv, title, 24 * k, tw, BOLD);
    let ty = cy + h - (sub ? 44 : 22) * k - (lines.length - 1) * 28 * k;
    lines.forEach((l) => { cv.text(l, tx, ty, 24 * k, C.text, BOLD); ty += 28 * k; });
    if (sub) cv.text(fit(cv, sub, 17 * k, tw, LIT), tx, cy + h - 18 * k, 17 * k, '#ffffffc0', LIT);
    if (focused) {
        const px = cx + w - 44 * k, py = cy + 44 * k;
        cv.circle(px, py, 25 * k, '#ffffffee');
        tri(cv, [[px - 7 * k, py - 11 * k], [px + 11 * k, py], [px - 7 * k, py + 11 * k]], '#111318');
    }
    ring(cv, m, 'app:' + a.id, cx, cy, w, h, r);
    cv.target(cx, cy, w, h, () => m.act.start(a), 'app:' + a.id, r);
}
function actionCard(cv, m, key, x, label, icon, run) {
    const y = CARD.y + 40, h = CARD.h - 80;
    cv.roundRect(x, y, ACTION_W, h, CARD.r, m.focus === key ? C.glass2 : C.glass);
    icon(cv, x + ACTION_W / 2, y + h / 2 - 22, 22, C.text);
    cv.text(label, x + ACTION_W / 2, y + h / 2 + 46, 22, C.dim, { literal: true, align: 'center' });
    ring(cv, m, key, x, y, ACTION_W, h, CARD.r);
    cv.target(x, y, ACTION_W, h, run, key, CARD.r);
}
/** a wide button (pill), centred on cx */
function button(cv, m, key, cx, y, label, run, fill) {
    const w = cv.textWidth(label, 24, BOLD) + 64;
    cv.roundRect(cx - w / 2, y, w, 52, 26, fill || C.blue);
    cv.text(label, cx, y + 35, 24, C.text, { literal: true, font: 'bold', align: 'center' });
    ring(cv, m, key, cx - w / 2, y, w, 52, 26);
    cv.target(cx - w / 2, y, w, 52, run, key, 26);
}

/* ---------- home ---------- */
function statusOf(m) {
    const st = m.st;
    if (!st.up) return { dot: '#8e8e93', text: 'Outil jap-moonride absent' };
    if (st.pin) return { dot: C.orange, text: 'Jumelage…' };
    if (!st.host) return { dot: '#8e8e93', text: 'Pas encore jumelé' };
    if (st.offline) return { dot: '#8e8e93', text: 'PC introuvable' };
    const rtt = st.stats && st.stats.rtt ? ' · ' + st.stats.rtt + ' ms' : '';
    return { dot: C.green, text: (st.hostname || st.host) + rtt };
}
function header(cv, m, title) {
    const tw = cv.text(title, 40, 98, 44, C.text, BOLD);
    return 40 + tw + 20;
}
function home(cv, m) {
    const st = m.st, s = statusOf(m), py = L.pillY, cy = py + 22;
    // the app's name: the kit's header has it already where it draws one (full-screen layout)
    const sx = pill(cv, m.chrome || L === BIG ? 40 : header(cv, m, 'Moonride'), L.pillY, s.text, s.dot);
    const desk = st.host && !st.offline && !st.pin ? st.apps.find(isDesktop) : null, dw = 158;
    if (desk) {
        cv.roundRect(sx + 12, py, dw, 44, 22, m.focus === 'desktop' ? C.glass2 : C.glass);
        monitor(cv, sx + 42, cy - 1, 13, C.text, '#1a2236');
        cv.text('Bureau', sx + 66, cy + 8, 22, C.text, BOLD);
        ring(cv, m, 'desktop', sx + 12, py, dw, 44, 22);
    }
    // right: "•••" (round); open, the pads then Settings to its left. Closed, the covers have the page
    cv.circle(1534, cy, 26, m.focus === 'menu' || m.menu ? C.glass2 : C.glass);
    [-10, 0, 10].forEach((d) => cv.circle(1534 + d, cy, 3.5, C.text));
    ring(cv, m, 'menu', 1508, py - 4, 52, 52, 26);
    const pn = m.pads.conn.size, ptext = pn ? (pn === 1 ? '1 manette' : pn + ' manettes') : 'Manettes';
    // open: Manettes, Quitter (the app ends, the game on the PC too), Settings
    const qw = cv.textWidth('Quitter', 22, BOLD) + 44, qx = 1430 - qw;
    const pw = cv.textWidth(ptext, 22, BOLD) + 82, px = qx - 12 - pw;
    if (m.menu) {
        cv.roundRect(qx, py, qw, 44, 22, m.focus === 'quit' ? C.glass2 : C.glass);
        cv.text('Quitter', qx + 22, cy + 8, 22, C.text, BOLD);
        ring(cv, m, 'quit', qx, py, qw, 44, 22);
        cv.roundRect(px, py, pw, 44, 22, m.focus === 'pads' ? C.glass2 : C.glass);
        pad(cv, px + 32, cy, 13, C.text, '#1a2236');
        cv.text(ptext, px + 56, cy + 8, 22, C.text, BOLD);
        ring(cv, m, 'pads', px, py, pw, 44, 22);
        cv.circle(1472, cy, 26, m.focus === 'settings' ? C.glass2 : C.glass);
        gear(cv, 1472, cy, 13, C.text);
        ring(cv, m, 'settings', 1446, py - 4, 52, 52, 26);
    }
    // the row: the host's apps, then Actualiser and Jumeler; or a message where there are none
    cv.clip(L.clipX, L === BIG ? 0 : TOP, W - 2 * L.clipX, H + (m.extra || 0));
    if (!st.up || !st.host || !st.apps.length) empty(cv, m);
    else {
        const items = games(st.apps).map((a) => ({ app: a })).concat([{ key: 'refresh' }, { key: 'pair' }]);
        const first = Math.max(0, Math.min(m.first, items.length - SHOWN));
        let focused = null;
        const n0 = cv.targets.length;
        // the focused card last: it is drawn bigger, over its neighbours
        for (let i = Math.max(0, Math.floor(first) - 1); i < Math.min(items.length, Math.ceil(first) + SHOWN + 1); i++) {
            const it = items[i], x = CARD.x + (i - first) * PITCH;
            if (it.app && m.focus === 'app:' + it.app.id) { focused = { a: it.app, x }; continue; }
            if (it.app) appCard(cv, m, it.app, x, false);
            else if (it.key === 'refresh') actionCard(cv, m, 'refresh', x, 'Actualiser', refreshIcon, m.act.refresh);
            else actionCard(cv, m, 'pair', x, 'Jumeler', plus, m.act.pair);
        }
        if (focused) appCard(cv, m, focused.a, focused.x, true);
        // its target back in the row's order (the controller's knob goes along it)
        cv.targets.splice(n0).sort((p, q) => p.x - q.x).forEach((q) => cv.targets.push(q));
    }
    cv.noclip();
    footer(cv, m);
    // the header's targets after the row's: the controller's first turns go along the cards
    if (desk) cv.target(sx + 12, py, dw, 44, () => m.act.start(desk), 'desktop', 22);
    cv.target(1508, py - 4, 52, 52, m.act.menu, 'menu', 26);
    if (m.menu) {
        cv.target(px, py, pw, 44, m.act.pads, 'pads', 22);
        cv.target(qx, py, qw, 44, m.act.quit, 'quit', 22);
        cv.target(1446, py - 4, 52, 52, m.act.settings, 'settings', 26);
    }
    // the sheet takes the page: nothing behind it can be pressed (the daemon has no cancel; BACK leaves)
    if (st.risk) { cv.targets.length = 0; riskSheet(cv, m); } else if (st.pin) { cv.targets.length = 0; pinSheet(cv, m); } else if (st.tsSheet && st.tsUrl) { cv.targets.length = 0; tsSheet(cv, m); }
}
function empty(cv, m) {
    const st = m.st, y = CARD.y, h = CARD.h;
    cv.roundRect(CARD.x, y, W - 2 * CARD.x, h, CARD.r, C.glass);
    let t, sub, b = null;
    if (!st.up) { t = 'L\'outil jap-moonride ne répond pas'; sub = 'Il démarre avec la voiture : réessaie dans un instant.'; } else if (!st.host) {
        t = 'Associe la voiture à ton PC'; sub = m.host === '0.0.0.0' ? 'Règle d\'abord l\'adresse IP du PC dans les réglages (Host IP)' : 'PC : ' + m.host + ' (modifiable dans les réglages)'; b = ['pair', 'Jumeler', m.act.pair];
    } else if (st.offline) {
        t = 'PC introuvable'; sub = 'Vérifie que le PC ' + st.host + ' est allumé et sur le même réseau.'; b = ['refresh', 'Réessayer', m.act.refresh];
    } else { t = 'Chargement des jeux…'; sub = 'Le PC ' + (st.hostname || st.host) + ' envoie sa liste.'; b = ['refresh', 'Actualiser', m.act.refresh]; }
    cv.text(fit(cv, t, 36, 1400, BOLD), W / 2, y + 112, 36, C.text, { literal: true, font: 'bold', align: 'center' });
    cv.text(fit(cv, sub, 24, 1400, LIT), W / 2, y + 156, 24, C.dim, { literal: true, align: 'center' });
    if (b) button(cv, m, b[0], W / 2, y + 196, b[1], b[2]);
    // a paired host that went quiet can still be paired again (another PC, a new address)
    if (b && b[0] === 'refresh' && st.offline) button(cv, m, 'pair', W / 2 + 260, y + 196, 'Jumeler', m.act.pair, C.glass2);
}
function chip(cv, x, label, icon, color) {
    const w = cv.textWidth(label, 20, LIT) + 58;
    cv.roundRect(x, L.footY, w, 40, 12, C.glass);
    icon(x + 22, L.footY + 20);
    cv.text(label, x + 40, L.footY + 27, 20, color || C.text, LIT);
    return x + w + 12;
}
function footer(cv, m) {
    let x = 40;
    // the chips only with the menu open (or while it refuses to start: the car moves)
    if (m.parkedOnly && (m.menu || m.driving)) {
        x = chip(cv, x, !m.driving ? 'Stationné uniquement' : m.noSpeed ? 'Stationné uniquement : vitesse illisible, démarrage bloqué' : 'Stationné uniquement : en attente de l\'arrêt', (cx, cy) => {
            cv.roundRect(cx - 9, cy - 9, 18, 18, 4, m.driving ? C.orange : '#ffffffd0');
            cv.text('P', cx, cy + 6, 16, '#111318', { literal: true, font: 'bold', align: 'center' });
        }, m.driving ? C.orange : null);
    }
    // how to pick a card: the controller where the kit has it, else the HMI's bar buttons
    const hint = m.ring ? 'Suivant : choisir · Ouvrir : jouer' : 'Tourner : choisir · Appuyer : jouer';
    if (m.menu && m.st.apps.length && !m.st.pin) x = chip(cv, x, hint, (cx, cy) => cv.arc(cx, cy, 6, 9, 0, 360, '#ffffffd0'));
    // Tailscale waits for its login (the 5G relay): the chip opens the QR code
    if (m.st.tsUrl && (m.menu || m.st.offline)) {
        const x0 = x;
        x = chip(cv, x, 'Tailscale : se connecter', (cx, cy) => cv.arc(cx, cy, 6, 9, 0, 360, C.orange), C.orange);
        ring(cv, m, 'tslogin', x0, L.footY, x - x0 - 12, 40, 12);
        cv.target(x0, L.footY, x - x0 - 12, 40, m.act.tslogin, 'tslogin', 12);
    }
    if (m.live) {
        // streaming but GAME not in front (starting, stopping): Stop
        const label = m.st.state === 'launching' ? 'Démarrage… · Arrêter' : 'Arrêter le stream', w = cv.textWidth(label, 20, BOLD) + 58;
        cv.roundRect(x, L.footY, w, 40, 12, m.focus === 'stop' ? '#ff453a66' : '#ff453a40');
        cv.roundRect(x + 15, L.footY + 13, 14, 14, 3, C.red);
        cv.text(label, x + 40, L.footY + 27, 20, C.text, BOLD);
        ring(cv, m, 'stop', x, L.footY, w, 40, 12);
        cv.target(x, L.footY, w, 40, m.act.stop, 'stop', 12);
    }
    // right: what went wrong, else how many apps
    const n = games(m.st.apps).length, right = m.st.error ? m.st.error : n ? n + (n === 1 ? ' jeu' : ' jeux') : '';
    if (right) cv.text(fit(cv, right, 20, Math.max(200, 1560 - x - 24), LIT), 1560, L.footY + 27, 20, m.st.error ? C.orange : C.faint, { literal: true, align: 'right' });
}
function pinSheet(cv, m) {
    cv.fillRect(0, 0, W, H + (m.extra || 0), '#000000a8');
    const x = 340, y = 62, w = 920, h = 432, cx = x + w / 2;
    cv.roundRect(x, y, w, h, 34, C.sheet);
    cv.text('Associer la voiture à ton PC', cx, y + 58, 36, C.text, { literal: true, font: 'bold', align: 'center' });
    cv.text('Sur le PC, ouvre l\'interface web de Sunshine / Apollo › PIN et tape ce code.', cx, y + 100, 24, C.dim, { literal: true, align: 'center' });
    const pin = String(m.st.pin), bw = 104, gap = 18, bx = cx - (pin.length * bw + (pin.length - 1) * gap) / 2;
    for (let i = 0; i < pin.length; i++) {
        cv.roundRect(bx + i * (bw + gap), y + 126, bw, 124, 18, C.box);
        cv.text(pin[i], bx + i * (bw + gap) + bw / 2, y + 212, 64, C.text, { literal: true, font: 'bold', align: 'center' });
    }
    const url = 'https://' + m.host + ':47990/pin', uw = cv.textWidth(url, 24, BOLD) + 44;
    cv.roundRect(cx - uw / 2, y + 276, uw, 48, 12, '#1b3a5c');
    cv.text(url, cx, y + 308, 24, C.link, { literal: true, font: 'bold', align: 'center' });
    const ww = cv.textWidth('En attente du PC…', 24, LIT);
    spinner(cv, cx - ww / 2 - 22, y + 362, 10);
    cv.text('En attente du PC…', cx + 8, y + 370, 24, C.dim, { literal: true, align: 'center' });
}

const RISK = 'Streaming while driving is for passengers only. The driver must never watch or operate it. ' +
    'You use this at your own risk; the authors accept no liability for any damage, injury, fine or loss. ' +
    'Check that it is legal where you drive.';
/** Words of s in lines of at most w px. */
function wrap(cv, s, size, w) {
    const out = [];
    s.split(' ').forEach((wd) => {
        const l = out.length ? out[out.length - 1] + ' ' + wd : wd;
        if (out.length && cv.textWidth(l, size, LIT) <= w) out[out.length - 1] = l; else out.push(wd);
    });
    return out;
}
/* Turning "Parked only" off: the disclaimer, then I accept (applies it) or Cancel (it stays on) */
function riskSheet(cv, m) {
    cv.fillRect(0, 0, W, H + (m.extra || 0), '#000000a8');
    const x = 260, y = 40, w = 1080, h = 460, cx = x + w / 2;
    cv.roundRect(x, y, w, h, 34, C.sheet);
    cv.text('Streaming while driving', cx, y + 62, 36, C.text, { literal: true, font: 'bold', align: 'center' });
    wrap(cv, RISK, 26, w - 120).forEach((l, i) => cv.text(l, cx, y + 124 + i * 40, 26, C.dim2, { literal: true, align: 'center' }));
    button(cv, m, 'riskCancel', cx - 150, y + 370, 'Cancel', m.act.riskCancel, C.glass2);
    button(cv, m, 'riskAccept', cx + 150, y + 370, 'I accept', m.act.riskAccept, C.orange);
}

/* The jap-tailscale tool's login: the link as a QR code, for a phone signed in to the owner's Tailscale account */
function tsSheet(cv, m) {
    cv.fillRect(0, 0, W, H + (m.extra || 0), '#000000a8');
    const x = 300, y = 40, w = 1000, h = 460, cx = x + w / 2;
    cv.roundRect(x, y, w, h, 34, C.sheet);
    cv.text('Connecter Tailscale', cx, y + 58, 36, C.text, { literal: true, font: 'bold', align: 'center' });
    cv.text('Scanne ce code avec un téléphone connecté à ton compte Tailscale.', cx, y + 100, 24, C.dim, { literal: true, align: 'center' });
    const side = (qr.encode(m.st.tsUrl).length + 8) * 6;    // the code and its 4-module quiet zone
    qr.draw(cv, m.st.tsUrl, cx - side / 2, y + 122, 6);
    cv.text(fit(cv, m.st.tsUrl, 22, w - 80, LIT), cx, y + 418, 22, C.link, { literal: true, align: 'center' });
    cv.target(0, 0, W, H + (m.extra || 0), m.act.tslogin, 'tslogin', 0);
}

/* ---------- Manettes ---------- */
const DONGLE = { none: 'aucun dongle Bluetooth branché', searching: 'recherche du dongle…', init: 'démarrage du dongle…',
    up: 'prêt', unusable: 'dongle inutilisable' };
/** The groups of the pads page: [{ title, rows: [{ key?, icon, title, sub, right, pct, color }] }] */
function padGroups(m) {
    const st = m.st, p = m.pads;
    const groups = [{ title: 'DONGLE USB', rows: [{ icon: 'usb', color: C.green, title: 'Adaptateur USB 8BitDo',
        sub: 'Associe la manette avec le bouton du dongle' }] }];
    // pads the Bluetooth helper knows (connected or bonded); the USB pad sends no state to the app
    const pads = m.padRows.filter((r) => r.op === 'forget').map((r) => {
        const armed = p.armed === r.addr;
        return { key: 'pad:' + r.addr, icon: 'pad', color: C.blue, title: r.name,
            sub: armed ? 'Toucher encore pour oublier cette manette' : r.conn ? 'Connectée · Bluetooth' : 'Associée · Bluetooth',
            subColor: armed ? C.red : null, pct: r.pct, run: () => m.act.pad(r) };
    });
    if (!pads.length) pads.push({ icon: 'pad', color: C.blue, title: 'Manette sur le dongle USB', sub: 'Joueur 1 pendant le stream' });
    groups.push({ title: 'MANETTES', rows: pads });
    if (st.up && st.bt) {
        const rows = [{ icon: 'bt', color: '#636366', title: 'Dongle Bluetooth',
            sub: p.dongle ? DONGLE[p.dongle] || p.dongle : 'état inconnu', right: p.dmsg || '' }];
        rows.push({ key: 'scan', icon: 'plus', color: '#3a3a3c', title: p.scan ? 'Recherche en cours… toucher pour arrêter' : 'Rechercher des manettes Bluetooth',
            link: true, run: m.act.scan });
        m.padRows.filter((r) => r.op === 'pair').forEach((r) => rows.push({ key: 'pair:' + r.addr, icon: 'plus', color: '#3a3a3c',
            title: 'Associer : ' + r.name, sub: r.addr, link: true, run: () => m.act.pad(r) }));
        groups.push({ title: 'BLUETOOTH', rows });
    }
    return groups;
}
// the key tester under the help: what the USB pad sends right now (XInput button bits, as Moonlight's)
const KEYS = [['A', 0x1000], ['B', 0x2000], ['X', 0x4000], ['Y', 0x8000], ['LB', 0x100], ['RB', 0x200], ['LT', 'lt'], ['RT', 'rt'],
    ['L3', 0x40], ['R3', 0x80], ['Vue', 0x20], ['Menu', 0x10], ['Xbox', 0x400]];
function padTester(cv, m) {
    const t = m.pads.test, x0 = 40, y0 = 368;
    cv.text('TEST DES TOUCHES', x0, y0, 18, C.faint, { literal: true, font: 'bold', spacing: 1.5 });
    cv.text(t ? 'Manette détectée' : 'Aucune manette USB', x0 + 440, y0, 18, t ? C.green : C.orange, { literal: true, align: 'right' });
    const on = (k) => !!t && (typeof k === 'string' ? t[k] > 30 : (t.b & k) !== 0);
    KEYS.forEach(([label, k], i) => {
        const row = i < 8 ? 0 : 1, col = row ? i - 8 : i, w = row ? 62 : 50, x = x0 + col * (w + 5), y = y0 + 14 + row * 40;
        cv.roundRect(x, y, w, 32, 10, on(k) ? C.blue : C.glass);
        cv.text(label, x + w / 2, y + 23, 17, on(k) ? C.text : C.dim, { literal: true, font: 'bold', align: 'center' });
    });
    // d-pad: four squares around a centre, then the two sticks (the dot is the stick's position)
    const dx = x0 + 22, dy = y0 + 120, D = [[0x1, 0, -1], [0x2, 0, 1], [0x4, -1, 0], [0x8, 1, 0]];
    D.forEach(([b, ox, oy]) => cv.roundRect(dx + ox * 20 - 9, dy + oy * 20 - 9, 18, 18, 4, on(b) ? C.blue : C.glass2));
    [['lx', 'ly'], ['rx', 'ry']].forEach(([kx, ky], i) => {
        const cx = x0 + 110 + i * 70, cy = dy;
        cv.circle(cx, cy, 24, C.glass);
        cv.circle(cx + (t ? t[kx] / 32768 * 16 : 0), cy - (t ? t[ky] / 32768 * 16 : 0), 8, t ? C.text : C.faint);
    });
    if (t) cv.text('LT ' + t.lt + '  RT ' + t.rt, x0 + 440, dy + 7, 18, C.dim, { literal: true, align: 'right' });
}
const ROW_H = 84, GROUP_GAP = 54, PX = 520, PW = 1040;
function padsPage(cv, m) {
    header(cv, m, 'Manettes');
    const help = ['Allume la manette et appuie sur le', 'bouton d\'association du dongle 8BitDo.', '',
        'Elle sert de manette 1 pendant le stream.'];
    help.forEach((l, i) => { if (l) cv.text(l, 40, 158 + i * 32, 24, C.dim, LIT); });
    let note = m.pads.note;
    if (!m.st.up) note = 'Outil jap-moonride absent';
    if (note) cv.text(fit(cv, note, 22, 440, LIT), 40, 296, 22, C.orange, LIT);
    padTester(cv, m);
    // close (back home), where Settings is on the home page
    cv.circle(1534, 80, 26, m.focus === 'close' ? C.glass2 : C.glass);
    cross(cv, 1534, 80, 9, C.text);
    ring(cv, m, 'close', 1508, 54, 52, 52, 26);

    const bottom = H + (m.extra || 0);
    cv.clip(PX - 12, 112, PW + 24, bottom - 112);
    let y = 132 - m.padSy;
    padGroups(m).forEach((g) => {
        cv.text(g.title, PX + 22, y - 12, 18, C.faint, { literal: true, font: 'bold', spacing: 1.5 });
        const gh = g.rows.length * ROW_H;
        cv.roundRect(PX, y, PW, gh, 22, C.glass);
        g.rows.forEach((r, i) => {
            const ry = y + i * ROW_H;
            if (i) cv.fillRect(PX + 96, ry, PW - 96, 1, '#ffffff14');
            if (r.key && m.focus === r.key) cv.roundRect(PX, ry, PW, ROW_H, 22, '#ffffff12');
            cv.roundRect(PX + 24, ry + 16, 52, 52, 12, r.color);
            const ix = PX + 50, iy = ry + 42;
            if (r.icon === 'usb') usb(cv, ix, iy, 16, C.text);
            else if (r.icon === 'pad') pad(cv, ix, iy - 2, 15, C.text, r.color);
            else if (r.icon === 'plus') plus(cv, ix, iy, 11, C.text);
            else { cv.polyline([[ix - 9, iy - 8], [ix + 9, iy + 8], [ix, iy + 16], [ix, iy - 16], [ix + 9, iy - 8], [ix - 9, iy + 8]], 3.5, C.text); }   // Bluetooth rune
            const tx = PX + 96, rw = r.pct != null ? 140 : r.right ? cv.textWidth(r.right, 22, LIT) + 40 : 24;
            if (r.sub) {
                cv.text(fit(cv, r.title, 26, PW - 96 - rw, BOLD), tx, ry + 38, 26, r.link ? C.blue : C.text, BOLD);
                cv.text(fit(cv, r.sub, 18, PW - 96 - rw, LIT), tx, ry + 64, 18, r.subColor || C.dim, LIT);
            } else cv.text(fit(cv, r.title, 26, PW - 96 - rw, BOLD), tx, ry + 52, 26, r.link ? C.blue : C.text, BOLD);
            if (r.pct != null) {
                battery(cv, PX + PW - 120, ry + 33, r.pct, r.pct <= 20 ? C.red : C.green);
                cv.text(r.pct + ' %', PX + PW - 24, ry + 50, 22, C.dim, { literal: true, align: 'right' });
            } else if (r.right) cv.text(r.right, PX + PW - 24, ry + 50, 22, C.dim, { literal: true, align: 'right' });
            if (r.key) {
                ring(cv, m, r.key, PX, ry, PW, ROW_H, 22);
                // a row scrolled up under the title keeps a 1 px target (the controller can turn back to it), not one over Close
                const ty = Math.max(ry, 112);
                cv.target(PX, ty, PW, Math.max(1, ry + ROW_H - ty), r.run, r.key, 22);
                m.rowY[r.key] = ry + m.padSy;
            }
        });
        y += gh + GROUP_GAP;
    });
    cv.noclip();
    // close (back home) after the rows: the controller's first turns go along them
    cv.target(1508, 54, 52, 52, m.act.close, 'close', 26);
}

/* ---------- loading: from the tap until the stream shows (the PC's own loading picture takes over then) ---------- */
function loading(cv, m) {
    const l = m.st.launch, a = m.st.apps.find((x) => x.id === l.app.id) || l.app, el = Math.max(0, m.now - l.t), bottom = H + (m.extra || 0);
    const full = String(a.title || ''), cut = full.search(/: | - /);
    const title = cut > 0 ? full.slice(0, cut) : full, rest = cut > 0 ? full.slice(cut + 2).trim() : null;
    const col = PALETTE[hash(title) % PALETTE.length];
    // the game's colour washed over the night background, and a slow glow breathing behind the cover
    cv.rampRect(0, 0, W, bottom, 0, [col[0] + '66', col[1] + '33', '#00000000']);
    const cw = 300, ch = 450, cx = 150, cy = (bottom - ch) / 2, pulse = 0.5 + 0.5 * Math.sin(el / 450);
    cv.circle(cx + cw / 2, cy + ch / 2, 250 + 20 * pulse, col[0] + '22');
    cv.circle(cx + cw / 2, cy + ch / 2, 200 + 14 * pulse, col[0] + '30');
    cv.card(cx, cy, cw, ch, 28, [[0, col[0]], [1, col[1]]]);
    const pid = m.pic ? m.pic(a) : null;
    if (pid) { if (cv.place) cv.picture(pid, cx, cy, cw, ch, 28); else cv.image(pid, cx, cy, cw, ch); }
    else if (/desktop|bureau/i.test(title)) monitor(cv, cx + cw / 2, cy + ch / 2, 60, '#e8eef8', col[0]);
    // right: the name, what is happening, a bar that never stops moving
    const x = 560, tw = 900;
    cv.text('LANCEMENT', x, cy + 70, 20, C.faint, { literal: true, font: 'bold', spacing: 2 });
    const lines = wrap2(cv, title, 56, tw, BOLD);
    let y = cy + 140;
    lines.forEach((t, i) => { if (i) y += 64; cv.text(t, x, y, 56, C.text, BOLD); });
    if (rest) { y += 44; cv.text(fit(cv, rest, 28, tw, LIT), x, y, 28, C.dim, LIT); }
    const step = el < 4000 ? 'Connexion au PC' : el < 15000 ? 'Le PC passe en mode jeu' : 'Démarrage du jeu';
    const dots = '...'.slice(0, 1 + Math.floor(el / 400) % 3);
    cv.text(step + dots, x, y + 70, 26, C.dim2, LIT);
    const by = y + 100, bw = 620, seg = 180, p = (el % 1600) / 1600, sx = x - seg + p * (bw + seg);
    cv.roundRect(x, by, bw, 8, 4, C.glass2);
    cv.clip(x, by, bw, 8);
    cv.roundRect(sx, by, seg, 8, 4, C.blue);
    cv.noclip();
    cv.text(Math.floor(el / 1000) + ' s', x + bw, by + 40, 20, C.faint, { literal: true, align: 'right' });
    button(cv, m, 'stop', x + 80, by + 72, 'Annuler', m.act.stop, C.glass2);
}

/** One frame of the page (see the header). m.rowY comes back filled: where each pads row is, unscrolled. */
function draw(cv, m) {
    m.rowY = {};
    layout(m.mode === 'pads' ? 0 : m.extra || 0);
    background(cv, H + (m.extra || 0));
    if (m.st.launch && m.mode !== 'pads') loading(cv, m); else if (m.mode === 'pads') padsPage(cv, m); else home(cv, m);
}

/** The home row's items, in order: their keys (main.js keeps the focused one in view). */
// the host's Desktop is the bubble next to the status, not a card
const isDesktop = (a) => /^(desktop|bureau)$/i.test(String(a.title || '').trim());
const games = (apps) => apps.filter((a) => !isDesktop(a));
const rowKeys = (apps) => games(apps).map((a) => 'app:' + a.id).concat(['refresh', 'pair']);

/* ---------- GAME: the performance overlay ---------- */
// one decimal, French comma; '–' for a field this stream binary does not send
const n1 = (v) => (typeof v === 'number' && isFinite(v) ? v.toFixed(1).replace('.', ',') : '–');
const pct = (a, n) => (typeof a === 'number' && n > 0 ? n1(100 * a / n) : '–');
function statRows(s) {
    const ms = (a, max) => n1(a) + ' ms' + (max !== undefined ? '  (max ' + n1(max) + ')' : '');
    return [
        ['Flux vidéo', (s.w || '–') + ' × ' + (s.h || '–') + ' · ' + (s.hz || '–') + ' fps · ' + (s.codec || 'H.264') + ' · ' + n1(s.kbps / 1000) + ' Mbps'],
        ['Images reçues / affichées', (s.fps != null ? s.fps : '–') + ' / ' + (s.shown != null ? s.shown : '–') + ' fps'],
        ['Perdues par le réseau', pct(s.lost, s.fps + (s.lost || 0)) + ' %'],
        ['Sautées / échecs décodeur', pct(s.skipped, s.fps) + ' % / ' + pct(s.failed, s.fps) + ' %'],
        ['Latence réseau (RTT)', (s.rtt != null ? s.rtt : '–') + ' ± ' + (s.rttvar != null ? s.rttvar : '–') + ' ms'],
        ['Traitement hôte', ms(s.host_ms, s.host_max)],
        ['Décodage', ms(s.decode_ms, s.decode_max)],
        ['File / affichage', n1(s.queue_ms) + ' / ' + n1(s.present_ms) + ' ms'],
        ['Total client (réception à affichage)', ms(s.client_ms, s.client_max)],
    ];
}
function stats(cv, s) {
    const rows = statRows(s || {}), size = 22, lh = 31, pad = 16, gap = 20, x = 16, y = 16;
    const lw = Math.max.apply(null, rows.map((r) => cv.textWidth(r[0], size, LIT)));
    const vw = Math.max.apply(null, rows.map((r) => cv.textWidth(r[1], size, BOLD)));
    cv.roundRect(x, y, pad * 2 + lw + gap + vw, pad * 2 + rows.length * lh - 8, 14, '#000000d1');   // (dark enough for small text over a bright game)
    rows.forEach((r, i) => {
        const by = y + pad + 22 + i * lh;
        cv.text(r[0], x + pad, by, size, C.dim2, LIT);
        cv.text(r[1], x + pad + lw + gap, by, size, C.text, BOLD);
    });
}

module.exports = { isDesktop, draw, stats, statRows, rowKeys, fit, W, H, TOP, ROW_H, shown: (extra) => (layout(extra || 0), SHOWN),
    pitch: (extra) => (layout(extra || 0), PITCH) };
