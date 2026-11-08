'use strict';
// Offline smoke test of the built jap_moonride app: a stubbed HMI, a fake moonlightd ctl socket and a fake
// mgu-render socket (native dialect). MAIN is drawn (view.js): the stub's canvas is the kit's Recorder, and the
// checks read the text each frame draws and press its targets by key. Build first (kit/tools/build.py jap_moonride), then:
//   node test/app/smoke.js <dist/jap_moonride> <tmpdir>      (Node 8: docker run --network none node:8.16.0-alpine ...)
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const stage = process.argv[2], tmp = process.argv[3];
const SRC = path.join(stage, 'source', 'javascript');
const spec = JSON.parse(fs.readFileSync(path.join(SRC, 'kit', 'app-spec.json'), 'utf8'));
const CTL = path.join(tmp, 'ctl.sock'), REN = path.join(tmp, 'render.sock'), VID = path.join(tmp, 'mgu-video-jap-moonride');
[CTL, REN].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* none */ } });
fs.writeFileSync(VID, Buffer.alloc(64));
process.env.MGU_MOONLIGHT_CTL = CTL; process.env.MGU_RENDERD_SOCKET = REN; process.env.MGU_MOONLIGHT_VIDEO = VID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms) { const end = Date.now() + (ms || 3000); while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(10); } }
const logs = [];
const log = { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), error: (m, e) => { logs.push('E ' + m + ' ' + (e && e.stack || e || '')); }, debug() {} };

/* ---- fake daemon ---- */
const d = { got: [], c: null };
const dsrv = net.createServer((c) => {
    d.c = c; let b = ''; c.setEncoding('utf8');
    c.on('data', (x) => { b += x; let i; while ((i = b.indexOf('\n')) >= 0) { d.got.push(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } });
    c.on('error', () => {});
}).listen(CTL);
d.send = (o) => d.c.write(JSON.stringify(o) + '\n');
d.cmds = (cmd) => d.got.filter((m) => m.cmd === cmd);

/* ---- fake renderer ---- */
const r = { msgs: [], c: null, hello: null };
const rsrv = net.createServer((c) => {
    r.c = c; let b = Buffer.alloc(0);
    c.on('data', (x) => {
        b = Buffer.concat([b, x]);
        while (b.length >= 8) {
            const t = b.readUInt32LE(0), n = b.readUInt32LE(4);
            if (b.length < 8 + n) break;
            const p = b.slice(8, 8 + n); b = b.slice(8 + n);
            if (t === 1) {
                r.hello = p.toString();
                const xr = Buffer.alloc(52); xr.writeUInt32LE(1, 0); xr.writeUInt32LE(1, 4); xr.writeUInt32LE(1 | 2 | 8 | 16, 8);
                const rd = Buffer.alloc(12); rd.writeUInt32LE(1920, 4); rd.writeUInt32LE(720, 8);
                [[0x4d520101, xr], [101, rd]].forEach((m) => { const h = Buffer.alloc(8); h.writeUInt32LE(m[0], 0); h.writeUInt32LE(m[1].length, 4); c.write(Buffer.concat([h, m[1]])); });
            } else r.msgs.push({ t, p, at: Date.now() });
        }
    });
    c.on('error', () => {});
}).listen(REN);
r.send = (t, p) => { const h = Buffer.alloc(8); h.writeUInt32LE(t, 0); h.writeUInt32LE(p.length, 4); r.c.write(Buffer.concat([h, p])); };
r.types = (t) => r.msgs.filter((m) => m.t === t);
r.last = (ts) => { const m = r.msgs.filter((x) => ts.indexOf(x.t) >= 0); return m.length ? m[m.length - 1].t : null; };

/* ---- stub HMI ---- */
const handlers = {}, texts = {}, visible = {}, visH = [], loops = {};
// the frames MAIN draws: the strings on it and its targets (the kit's Recorder, its text calls noted)
const { Recorder, imageById } = require(path.join(SRC, 'kit', 'record'));
const rtext = Recorder.prototype.text;
Recorder.prototype.text = function (s) { (this.said || (this.said = [])).push(String(s)); return rtext.apply(this, arguments); };
// GAME's recording (the one with the video op): its text is the performance overlay
let gameCv = null;
const rvideo = Recorder.prototype.video;
Recorder.prototype.video = function () { gameCv = this; return rvideo.apply(this, arguments); };
const gameSays = (re) => !!gameCv && (gameCv.said || []).some((x) => re.test(x));
let shot = { said: [], targets: [], images: [] };
let stack = [];
const top = () => stack[stack.length - 1];
function setTop(n) { const old = top(); if (old === n) return; if (old) visH.forEach((f) => f(old, false)); if (n) visH.forEach((f) => f(n, true)); }
const ui = {
    rhmi: null,
    image: (n, cv) => { assert.strictEqual(n, 'MAIN_GFX'); shot = { said: cv.said || [], targets: cv.targets.slice(), images: Array.from(cv.images) }; return Promise.resolve(); },
    text: (n, t) => { texts[n] = t; return Promise.resolve(); },
    visible: (n, on) => { visible[n] = on; return Promise.resolve(); },
    onClick: (n, fn) => { handlers[n] = fn; },
    open: (n) => { const old = top(); stack.push(n); if (old !== n) { if (old) visH.forEach((f) => f(old, false)); visH.forEach((f) => f(n, true)); } return Promise.resolve(); },
    back: () => { const old = stack.pop(); setTopFrom(old); },
    isVisible: (n) => top() === n, hasFocus: () => true, onVisible: (fn) => visH.push(fn), onFocus() {},
};
function setTopFrom(old) { visH.forEach((f) => f(old, false)); if (top()) visH.forEach((f) => f(top(), true)); }
const click = (n) => { assert.ok(handlers[n], 'handler ' + n); handlers[n]({}); };
// MAIN's next frame (drawn only when something changed), what it says, its targets, a press on one
const draw = () => { if (loops.MAIN) loops.MAIN(); return shot; };
const says = (re) => draw().said.some((s) => re.test(s));
const keys = () => draw().targets.map((x) => x.key);
const tap = (key) => { const x = draw().targets.find((q) => q.key === key); assert.ok(x, 'target ' + key + ' in ' + keys().join(' ')); x.run(); };

const values = {}; spec.settings.forEach((s) => { values[s.key] = s.default; });
assert.strictEqual(values.parkedOnly, true, 'parkedOnly on by default');
values.parkedOnly = false;    // a saved settings file with it off but no acceptance on record: the app turns it back on
const listeners = [];
const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; listeners.forEach((f) => f(k, v)); }, onChange: (f) => listeners.push(f) };
const sig = {};
const signals = { watch: (iface, inst, h) => { sig[iface] = h; return Promise.resolve({}); } };
// the speed as the car gives it: read again every second (the kit polls it every 2 s); parked.js counts a reading
// older than 5 s as moving
let speedT = null;
const speed = (kmh) => {
    const feed = () => sig['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2({ speedVehicleCentreOfGravity: kmh / 0.015625 });
    clearInterval(speedT); feed(); speedT = setInterval(feed, 1000);
};

const hooks = {};
// MainApp's joynr: the stopApp calls the "Quit" makes
const stops = [];
process.env.VIN = 'WBATEST0000000000';
const app = Object.assign(new EventEmitter(), {
    getAppId: () => 'jap_moonride',
    joynrProxyFactory: { create: (domain, P) => ({ init() {
        const op = function (self, s, name) { this.buildFunction = () => (a) => { stops.push({ domain, iface: self.interfaceName, name, a }); return Promise.resolve(); }; };
        this.builtProxy = new P({ proxyElementTypes: { ProxyOperation: op } }); return Promise.resolve(this);
    } }) },
});
const ctx = {
    ui, settings, log, spec, signals, dataDir: tmp, app,
    canvas: (w, h) => new Recorder(w, h), loop: (n, fps, fn) => { loops[n] = fn; },
    onPageFocus: (fn) => { hooks.focus = fn; }, onBack: (fn) => { hooks.back = fn; }, onLayout() {}, hideButton() {},
};
const realLoad = Module._load;
Module._load = function (req) {
    if (req === './kit/mgu') return { run: (impl) => impl.start(ctx), log };
    return realLoad.apply(this, arguments);
};

(async () => {
    require(path.join(SRC, 'app.js'));
    stack = ['MAIN']; visH.forEach((f) => f('MAIN', true));
    // the kit's display draws the first canvas screen only: MAIN, never GAME (the app's own renderer connection)
    assert.strictEqual(spec.screens.filter((s) => s.kind === 'canvas')[0].name, 'MAIN', 'MAIN is the first canvas screen');
    await until(() => d.cmds('status').length, 'status on connect');
    await until(() => r.hello && r.hello.indexOf('jap_moonride\0proto=mgu-render/1') === 0, 'native HELLO');
    await until(() => r.types(2).length && r.types(9).length, 'PLACE + CLAIM');
    d.send({ ev: 'state', state: 'idle', host: '192.0.2.10', stream: null, bt: true });
    await until(() => d.cmds('applist').length, 'applist after a status with a host');
    d.send({ ev: 'apps', apps: [{ id: 11, title: 'Desktop' }, { id: 22, title: 'Steam Big Picture' }] });
    await until(() => says(/^Steam Big$/) && says(/^Picture$/), 'app cards (titles in two lines)');
    assert.deepStrictEqual(keys().filter((k) => /^app:/.test(k)), ['app:22'], 'one card per game, Desktop not among them');
    assert(keys().indexOf('desktop') >= 0 && says(/^Desktop$/), 'Desktop as the bubble');

    // parkedOnly on by default (public build)
    assert.strictEqual(settings.get('parkedOnly'), true, 'off without an acceptance on record: back on at start');
    // no speed read yet: counts as moving -> start refused
    tap('desktop');
    await sleep(100);
    assert.strictEqual(d.cmds('start').length, 0, 'start refused with no speed');
    assert.ok(says(/refused/), 'says why: ' + draw().said.join(' | '));
    // parkedOnly cannot be turned off while moving
    settings.set('parkedOnly', false);
    assert.strictEqual(values.parkedOnly, true, 'parkedOnly back on while moving');

    // no default host: pairing refused until the PC's address is set
    tap('pair');
    await sleep(100);
    assert.strictEqual(d.cmds('pair').length, 0, 'no pair without a host');
    assert.ok(says(/PC's address/), 'says to set the host: ' + draw().said.join(' | '));
    [192, 0, 2, 10].forEach((n, i) => settings.set('host' + (i + 1), n));
    // pairing: the host from host1..4, then the PIN line
    tap('pair');
    await until(() => d.cmds('pair').length, 'pair');
    assert.deepStrictEqual(d.cmds('pair')[0], { cmd: 'pair', host: '192.0.2.10' });
    d.send({ ev: 'pin', pin: '1234', hostname: 'MYPC' });
    await until(() => says(/^https:\/\/192\.0\.2\.10:47990\/pin$/), 'PIN sheet URL');
    assert.deepStrictEqual(['1', '2', '3', '4'].map((x) => draw().said.indexOf(x) >= 0), [true, true, true, true], 'PIN digits');
    assert.deepStrictEqual(keys(), [], 'nothing pressable behind the PIN sheet');
    d.send({ ev: 'paired', host: '192.0.2.10', hostname: 'MYPC' });
    await until(() => !says(/47990/), 'PIN sheet gone');
    await until(() => d.cmds('applist').length === 2, 'applist after paired');
    d.send({ ev: 'apps', apps: [{ id: 11, title: 'Desktop' }, { id: 22, title: 'Steam Big Picture' }, { id: 33, title: 'Among Us' }] });
    await until(() => says(/^Desktop$/) && says(/^MYPC/), 'app cards again, the host by name');

    // covers: a cover event -> that card drawn with the picture (the file's pixels); a short file -> the gradient, no error
    assert.deepStrictEqual(draw().images, [], 'no cover yet');
    const COV = path.join(tmp, '22-cafe.rgba'), px = Buffer.alloc(252 * 378 * 4, 0x7f);
    fs.writeFileSync(COV, px);
    d.send({ ev: 'cover', id: 22, path: COV, w: 252, h: 378 });
    await until(() => draw().images.length === 1, 'a cover drawn');
    const im = imageById.get(shot.images[0]);
    assert.ok(im && im.w === 252 && im.h === 378 && Buffer.compare(Buffer.from(im.data), px) === 0, 'the cover file\'s pixels');
    const SHORT = path.join(tmp, '33-bad.rgba');
    fs.writeFileSync(SHORT, Buffer.alloc(100));
    d.send({ ev: 'cover', id: 33, path: SHORT, w: 252, h: 378 });
    await until(() => draw() && logs.some((l) => /33-bad\.rgba: unreadable/.test(l)), 'short cover refused');
    assert.strictEqual(shot.images.length, 1, 'only the good cover drawn');
    assert.ok(says(/^Steam Big$/), 'the title stays over the cover');

    // parked: start
    speed(0);
    tap('desktop');
    await until(() => d.cmds('start').length, 'start');
    assert.deepStrictEqual(d.cmds('start')[0], { cmd: 'start', app: 11, w: 1920, h: 720, fps: 60, kbps: 8000, codec: 'auto', audio: 'car', keep: true });
    d.send({ ev: 'state', state: 'launching' });
    d.send({ ev: 'state', state: 'streaming' });
    await sleep(300);
    assert.notStrictEqual(top(), 'GAME', 'connected, no picture yet: still loading');
    d.send({ ev: 'stats', shown: 0 });
    await sleep(300);
    assert.notStrictEqual(top(), 'GAME', 'no frame shown yet');
    d.send({ ev: 'stats', shown: 3 });
    await until(() => top() === 'GAME', 'GAME opened on the first frame');
    await until(() => r.types(13).length && r.types(3).some((m) => m.p.readUInt32LE(0) === 1), 'VIDEO + SHOW 1');
    assert.ok(r.types(13)[0].p.slice(4).toString().indexOf(VID) === 0, 'VIDEO names the frame file');
    const f0 = r.types(7).length;
    await sleep(2100);
    const nf = r.types(7).length - f0;
    assert.ok(nf >= 3, 'keepalive frames: ' + nf + ' in 2.1 s');
    const fr = r.types(7)[r.types(7).length - 1].p;
    assert.strictEqual(fr.readUInt32LE(0), 1, 'CLEAR'); assert.strictEqual(fr.readUInt32LE(8), 19, 'op 19');
    assert.strictEqual(fr.readUInt32LE(8 + 24), 1, 'video id 1');

    // touch: phases and the conversion (1920x720 layer, 1920x720 stream: same px)
    const t = (ph, x, y) => { const p = Buffer.alloc(12); p.writeUInt32LE(ph, 0); p.writeFloatLE(x, 4); p.writeFloatLE(y, 8); r.send(105, p); };
    // a tap: the cursor there, a trembling finger does not move it, then a left click
    t(1, 100, 200); t(2, 104, 203); t(3, 104, 203);
    await until(() => d.cmds('btn').length === 2, 'tap');
    assert.deepStrictEqual(d.cmds('touch'), [{ cmd: 'touch', phase: 2, x: 100, y: 200 }]);
    assert.deepStrictEqual(d.cmds('btn').map((k) => [k.btn, k.down]), [[1, true], [1, false]], 'tap = left click');
    // a second tap close by: on the first's point (a double click)
    t(1, 112, 190); t(3, 112, 190);
    await until(() => d.cmds('btn').length === 4, 'double tap');
    assert.deepStrictEqual(d.cmds('touch')[1], { cmd: 'touch', phase: 2, x: 100, y: 200 }, 'second tap on the first');
    await sleep(450);
    // a moving finger: the left button pressed where it went down, held while it moves (a title bar)
    t(1, 300, 300); t(2, 340, 300); t(3, 360, 310);
    await until(() => d.cmds('btn').length === 6, 'drag');
    assert.deepStrictEqual(d.cmds('btn').slice(4).map((k) => [k.btn, k.down]), [[1, true], [1, false]], 'drag');
    assert.deepStrictEqual(d.cmds('touch').slice(2), [{ cmd: 'touch', phase: 2, x: 300, y: 300 }, { cmd: 'touch', phase: 2, x: 340, y: 300 }, { cmd: 'touch', phase: 2, x: 360, y: 310 }]);
    // held still, then lifted: a right click
    t(1, 500, 500); await sleep(800); t(3, 500, 500);
    await until(() => d.cmds('btn').length === 8, 'long touch');
    assert.deepStrictEqual(d.cmds('btn').slice(6).map((k) => [k.btn, k.down]), [[3, true], [3, false]], 'long touch = right click');
    const btn0 = d.cmds('btn').length;
    // controller from the renderer (X_CCU): the Desktop streams, so a knob click clockwise -> wheel one notch down
    const ccu = (seq, knob, press, tilt) => { const p = Buffer.alloc(8); p[0] = seq; p.writeUInt16BE(knob, 1); p[3] = press; p[4] = tilt; r.send(0x4d520103, p); };
    ccu(1, 100, 0, 0); ccu(2, 101, 0, 0); ccu(3, 101, 1, 0); ccu(4, 101, 0, 0);
    await until(() => d.cmds('scroll').length === 1 && d.cmds('btn').length === btn0 + 2, 'wheel + push');
    assert.deepStrictEqual(d.cmds('scroll'), [{ cmd: 'scroll', n: -1 }], 'Desktop: the knob is the wheel');
    assert.strictEqual(d.cmds('key').length, 0, 'no Down key on the Desktop');
    assert.deepStrictEqual(d.cmds('btn').slice(btn0).map((k) => [k.btn, k.down]), [[3, true], [3, false]], 'a short push: a right click');

    // the performance overlay: off by default (a stats line changes nothing: CLEAR + VIDEO only, no glyph atlas)
    assert.strictEqual(values.stats, false, 'stats overlay off by default');
    const lastFrame = () => r.types(7)[r.types(7).length - 1].p;
    const STATS = { ev: 'stats', fps: 58, shown: 57, skipped: 1, failed: 0, lost: 2, kbps: 8412, host_ms: 4.1, host_max: 6, assembly_ms: 0.4,
        queue_ms: 0.3, queue_max: 1.2, decode_ms: 5.2, decode_max: 9.8, present_ms: 1.1, client_ms: 8.9, client_max: 14, rtt: 3, rttvar: 1,
        w: 1920, h: 720, hz: 60, codec: 'H.264', audio: {} };
    d.send(STATS);
    await sleep(600);
    assert.strictEqual(lastFrame().length, 36, 'overlay off: CLEAR + VIDEO only');
    assert.strictEqual(r.types(4).length, 0, 'overlay off: no glyph atlas sent');
    assert.ok(!gameSays(/Mbps/), 'overlay off: no text');
    // on (the setting): drawn at once, over the video (the video op stays at word 2), its atlas uploaded
    const nf1 = r.types(7).length;
    settings.set('stats', true);
    await until(() => r.types(7).length > nf1 && lastFrame().length > 36, 'a frame with the overlay');
    assert.ok(r.types(4).length >= 1, 'glyph atlas sent');
    assert.strictEqual(lastFrame().readUInt32LE(8), 19, 'video op first, the overlay over it');
    assert.ok(gameSays(/^1920 × 720 · 60 fps · H\.264 · 8\.4 Mbps$/), 'stream line: ' + (gameCv.said || []).join(' | '));
    assert.ok(gameSays(/^58 \/ 57 fps$/) && gameSays(/^3\.3 %$/) && gameSays(/^1\.7 % \/ 0\.0 %$/), 'frame rates, network drops 2 / 60, skipped 1 / 58');
    assert.ok(gameSays(/^3 ± 1 ms$/) && gameSays(/^4\.1 ms  \(max 6\.0\)$/) && gameSays(/^8\.9 ms  \(max 14\.0\)$/), 'RTT, host, total');
    // a new stats line: recorded again; between two lines the keepalive sends the same frame
    d.send(Object.assign({}, STATS, { rtt: 9 }));
    await until(() => gameSays(/^9 ± 1 ms$/), 'overlay follows the stats');
    // the push held: the left button down until let go (a drag), no key; the overlay off from the setting
    const k0 = d.cmds('key').length, b0 = d.cmds('btn').length;
    ccu(5, 101, 1, 0); ccu(6, 101, 2, 0);
    await sleep(300);
    ccu(7, 101, 0, 0);
    await until(() => d.cmds('btn').length === b0 + 2, 'held push: left down, then up');
    assert.deepStrictEqual(d.cmds('btn').slice(b0).map((k) => [k.btn, k.down]), [[1, true], [1, false]]);
    assert.strictEqual(d.cmds('key').length, k0, 'no key from the push');
    assert.strictEqual(values.stats, true, 'a short hold leaves the overlay');
    ccu(8, 101, 1, 0); ccu(9, 101, 2, 0);
    await sleep(3100);
    ccu(10, 101, 0, 0);
    await until(() => values.stats === false, 'held 3 s: overlay off');
    await until(() => lastFrame().length === 36, 'frame without the overlay');

    // driving off: stop, DROP_VIDEO then SHOW 0, back to MAIN
    speed(20);
    await until(() => d.cmds('stop').length === 1, 'stop when moving');
    await until(() => top() === 'MAIN', 'MAIN after moving');
    await until(() => r.last([3]) === 3 && r.types(3).slice(-1)[0].p.readUInt32LE(0) === 0, 'SHOW 0');
    const drop = r.msgs.map((m) => m.t).lastIndexOf(14), show0 = r.msgs.map((m) => m.t).lastIndexOf(3);
    assert.ok(drop >= 0 && drop < show0, 'DROP_VIDEO before SHOW 0');
    d.send({ ev: 'state', state: 'idle' });
    const fAfter = r.types(7).length; await sleep(700);
    assert.strictEqual(r.types(7).length, fAfter, 'no frames once hidden');

    // again, parked; BACK leaves the game: stop + drop
    speed(0); await sleep(2100);    // (stop is sent at most once per 2 s)
    tap('app:22');
    await until(() => d.cmds('start').length === 2, 'second start');
    d.send({ ev: 'state', state: 'streaming' }); d.send({ ev: 'stats', shown: 1 });
    await until(() => top() === 'GAME' && r.types(3).slice(-1)[0].p.readUInt32LE(0) === 1, 'shown again');
    ui.back();
    await until(() => d.cmds('stop').length === 2, 'stop on BACK');
    assert.strictEqual(d.cmds('stop')[1].keep, false, 'BACK quits the game on the PC');
    await until(() => r.types(3).slice(-1)[0].p.readUInt32LE(0) === 0, 'SHOW 0 on BACK');
    d.send({ ev: 'state', state: 'idle' });

    // the owner's opt-out (parked, at their own risk): parkedOnly off, the stream then keeps going while moving
    // turning it off asks first: not applied until "I accept"; Cancel keeps it on
    settings.set('parkedOnly', false);
    assert.strictEqual(values.parkedOnly, true, 'off without acceptance: not applied');
    assert.ok(says(/^Streaming while driving$/) && says(/passengers only/), 'the disclaimer sheet');
    assert.deepStrictEqual(keys().sort(), ['riskAccept', 'riskCancel'], 'the sheet takes the page');
    tap('riskCancel');
    assert.strictEqual(values.parkedOnly, true, 'Cancel: parkedOnly stays on');
    assert.ok(!says(/^Streaming while driving$/) && values._parkedOffAccepted !== true, 'sheet closed, nothing accepted');
    settings.set('parkedOnly', false);
    tap('riskAccept');
    assert.strictEqual(values.parkedOnly, false, 'I accept: parkedOnly off');
    assert.strictEqual(values._parkedOffAccepted, true, 'the acceptance kept with the settings');
    settings.set('parkedOnly', true); settings.set('parkedOnly', false);
    assert.ok(says(/^Streaming while driving$/) && values.parkedOnly === true, 'on again drops the acceptance: asked again');
    tap('riskAccept');
    settings.set('parkedOnly', true); settings.set('parkedOnly', false);
    tap('riskAccept');
    assert.strictEqual(values.parkedOnly, false, 'parkedOnly can be turned off while parked');
    await sleep(2100);
    tap('app:22');
    await until(() => d.cmds('start').length === 3, 'third start');
    d.send({ ev: 'state', state: 'streaming' }); d.send({ ev: 'stats', shown: 1 });
    await until(() => top() === 'GAME', 'shown with parkedOnly off');
    speed(20); await sleep(300);
    assert.strictEqual(d.cmds('stop').length, 2, 'no stop while moving with parkedOnly off');
    ui.back();
    await until(() => d.cmds('stop').length === 3, 'stop on BACK (opt-out)');
    d.send({ ev: 'state', state: 'idle' });
    speed(0); settings.set('parkedOnly', true);

    // another app in front (setting "resume", on by default): the game is kept on the PC, resumed on the way back
    await sleep(2100);
    tap('app:22');
    await until(() => d.cmds('start').length === 4, 'fourth start');
    d.send({ ev: 'state', state: 'streaming' }); d.send({ ev: 'stats', shown: 1 });
    await until(() => top() === 'GAME', 'shown a fourth time');
    const away = stack; stack = []; setTopFrom('GAME');           // the HMI shows another app: none of ours visible
    await until(() => d.cmds('stop').length === 4, 'stop when another app is in front');
    assert.strictEqual(d.cmds('stop')[3].keep, true, 'kept on the PC');
    d.send({ ev: 'state', state: 'idle', parked: { app: 22, until: Date.now() + 600000 } });
    await sleep(400);
    assert.strictEqual(d.cmds('resume').length, 0, 'no resume while away');
    stack = away; visH.forEach((f) => f(top(), true));            // back in Moonride
    await until(() => d.cmds('resume').length === 1, 'resume on the way back');
    d.send({ ev: 'state', state: 'launching', parked: null }); d.send({ ev: 'state', state: 'streaming', parked: null }); d.send({ ev: 'stats', shown: 1 });
    await until(() => top() === 'GAME', 'resumed game shown');
    await sleep(2100);
    while (top() === 'GAME') ui.back();                           // (the stub stacks GAME twice; the HMI does not)
    await until(() => d.cmds('stop').length === 5 && d.cmds('stop')[4].keep === false, 'BACK after the resume quits');
    d.send({ ev: 'state', state: 'idle', parked: null });

    // the "•••" menu: closed, the covers alone (no Gamepads / Settings); open, both
    assert.ok(keys().indexOf('pads') < 0 && keys().indexOf('settings') < 0 && keys().indexOf('menu') >= 0, 'menu closed: ' + keys().join(' '));
    tap('menu');
    assert.ok(keys().indexOf('pads') >= 0 && keys().indexOf('settings') >= 0 && keys().indexOf('quit') >= 0, 'menu open: ' + keys().join(' '));
    const hdr = draw().targets.filter((q) => ['desktop', 'pads', 'quit', 'settings', 'menu'].indexOf(q.key) >= 0);
    hdr.forEach((p, i) => hdr.slice(i + 1).forEach((q) => assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x, 'header buttons apart: ' + p.key + ' ' + q.key)));
    // "Quit" with a game parked on the PC: a real stop first (the game quits), then MainApp is asked to stop the app
    d.send({ ev: 'state', state: 'idle', parked: { app: 22, until: Date.now() + 600000 } });
    await sleep(100);
    const nstop = d.cmds('stop').length;
    tap('quit');
    await until(() => d.cmds('stop').length === nstop + 1, 'stop on Quit');
    assert.strictEqual(d.cmds('stop')[nstop].keep, false, 'Quit: the game is not kept');
    await sleep(300);
    assert.strictEqual(stops.length, 0, 'MainApp not asked before the game ended');
    d.send({ ev: 'state', state: 'idle', parked: null });
    await until(() => stops.length === 1, 'stopApp asked');
    assert.deepStrictEqual([stops[0].domain, stops[0].iface, stops[0].name, stops[0].a.appId],
        ['VIN-WBATEST0000000000', 'de/bmw/infotainment/telematic/oap/appruntime/AppRuntime_ff', 'stopApp', 'jap_moonride'], 'stopApp on MainApp');
    tap('menu');

    assert.ok(!says(/Tailscale: sign in/), 'no Tailscale sign-in chip: IterioDev\'s Tailscale app shows its own login');
    if (keys().indexOf('pads') < 0) tap('menu');

    // the pads page: list on entry, rows, pair, forget twice
    tap('pads');
    await until(() => d.got.some((m) => m.cmd === 'pads' && m.op === 'list'), 'pads list on entry');
    d.send({ ev: 'pads', msg: { ev: 'dongle', state: 'up', addr: '00:1A:7D:00:00:01', msg: '' } });
    d.send({ ev: 'pads', msg: { ev: 'bonded', addr: 'AA:BB:CC:DD:EE:01', transport: 'le' } });
    d.send({ ev: 'pads', msg: { ev: 'connected', idx: 0, mask: 1, addr: 'AA:BB:CC:DD:EE:01', name: 'Xbox Wireless Controller', type: 'xbox' } });
    d.send({ ev: 'pads', msg: { ev: 'battery', idx: 0, pct: 80 } });
    d.send({ ev: 'pads', msg: { ev: 'list_end', bonded: 1, mask: 1 } });
    await until(() => says(/^80 %$/), 'pad row with battery');
    assert.ok(says(/^Xbox Wireless Controller$/), 'the pad by name');
    assert.ok(says(/^ready$/), 'dongle state: ' + draw().said.join(' | '));
    assert.ok(says(/^8BitDo USB adapter$/), 'the USB adapter row');
    tap('scan');
    await until(() => d.got.some((m) => m.cmd === 'pads' && m.op === 'scan' && m.on === true), 'scan on');
    d.send({ ev: 'pads', msg: { ev: 'found', addr: 'AA:BB:CC:DD:EE:02', name: 'Xbox Wireless Controller', rssi: -50, bonded: false } });
    await until(() => keys().indexOf('pair:AA:BB:CC:DD:EE:02') >= 0 && says(/^Pair: Xbox/), 'found row');
    tap('pair:AA:BB:CC:DD:EE:02');
    await until(() => d.got.some((m) => m.cmd === 'pads' && m.op === 'pair' && m.addr === 'AA:BB:CC:DD:EE:02'), 'pair sent');
    tap('pad:AA:BB:CC:DD:EE:01');
    await sleep(50);
    assert.ok(!d.got.some((m) => m.op === 'forget'), 'one tap does not forget');
    assert.ok(says(/forget/), 'asks for a second tap');
    tap('pad:AA:BB:CC:DD:EE:01');
    await until(() => d.got.some((m) => m.cmd === 'pads' && m.op === 'forget' && m.addr === 'AA:BB:CC:DD:EE:01'), 'forget on the second tap');
    assert.strictEqual(hooks.back(), true, 'the controller pushed left: back home, taken by the app');
    await until(() => d.got.some((m) => m.cmd === 'pads' && m.op === 'scan' && m.on === false), 'scan off on leaving');
    await until(() => keys().indexOf('desktop') >= 0, 'home again');
    assert.strictEqual(hooks.back(), false, 'on home the kit\'s own back (the app closes)');

    // the controller on a card past the fifth: the row scrolls so that it shows whole (page x 12..1588)
    d.send({ ev: 'apps', apps: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: i, title: 'Game ' + i })) });
    await until(() => keys().indexOf('app:8') < 0 && keys().indexOf('app:1') >= 0, 'eight cards, the last ones off screen');
    hooks.focus('app:8');
    const c8 = draw().targets.find((q) => q.key === 'app:8');
    assert.ok(c8 && c8.x >= 12 && c8.x + c8.w <= 1588, 'focused card in view: ' + JSON.stringify(c8 && [c8.x, c8.w]));
    assert.ok(says(/^1920 × 720 · 60 fps$/), 'the focused card says the stream mode');
    // the HMI's bar (where the page can't be touched): Next to the next target (Refresh), Open runs it
    const nl = d.cmds('applist').length;
    click('BTN_NEXT'); click('BTN_OK');
    await until(() => d.cmds('applist').length === nl + 1, 'Next + Open: applist');

    {   // touchpad: moves only in touch mode (3), a short still touch = left click; samples as measured 03/11
        const { Touchpad } = require('../../apps/jap_moonride/input');
        const mv = [], cl = [];
        const tp = new Touchpad((dx, dy) => mv.push([dx, dy]), (b) => cl.push(b));
        const s = (m, x, y) => ({ statusSystemModeFrontSide: m, touchCoordinatesX1FrontSide: x, touchCoordinatesY1FrontSide: y });
        tp.feed(s(0, 1, 2366), 0); tp.feed(s(0, 1, 2000), 10); tp.feed(s(0, 0, 0), 20);
        assert.deepStrictEqual([mv, cl], [[], []], 'no touch mode: nothing');
        tp.feed(s(3, 176, 359), 100); tp.feed(s(3, 176, 359), 105); tp.feed(s(3, 178, 357), 120); tp.feed(s(3, 0, 0), 130);
        assert.deepStrictEqual([mv, cl], [[], [1]], 'a short touch that barely moves = click, the cursor still');
        tp.feed(s(3, 179, 356), 300); tp.feed(s(3, 0, 0), 380);
        assert.deepStrictEqual([mv, cl], [[], [1, 1]], 'a second tap: a second click on the same spot = double click');
        mv.length = cl.length = 0;
        tp.feed(s(3, 100, 100), 400); tp.feed(s(3, 120, 100), 450); tp.feed(s(3, 160, 110), 500); tp.feed(s(3, 0, 0), 520);
        assert.deepStrictEqual([mv, cl], [[[60, 0], [120, -30]], []], 'a drag: moves once past the wobble (pad Y up = screen up), no click');
        // tap, then down again and moving: the left button held through the move (a drag)
        const bt = [];
        const tq = new Touchpad((dx, dy) => mv.push([dx, dy]), (b) => cl.push(b), (b, dn) => bt.push([b, dn]));
        mv.length = cl.length = 0;
        tq.feed(s(3, 200, 200), 1000); tq.feed(s(3, 0, 0), 1080);
        tq.feed(s(3, 200, 200), 1200); tq.feed(s(3, 230, 200), 1250); tq.feed(s(3, 0, 0), 1300);
        assert.deepStrictEqual([cl, bt, mv], [[1], [[1, true], [1, false]], [[90, 0]]], 'tap + down and move = drag');
        // a finger held still 700 ms: a right click, no left click at the lift
        mv.length = cl.length = bt.length = 0;
        tq.feed(s(3, 100, 100), 3000); tq.feed(s(3, 101, 100), 3400); tq.feed(s(3, 101, 101), 3750); tq.feed(s(3, 0, 0), 3800);
        assert.deepStrictEqual([cl, bt, mv], [[3], [], []], 'held still = right click');
    }
    {   // the knob on the Desktop: the wheel, clockwise = down (negative notches)
        const { Keys } = require('../../apps/jap_moonride/input');
        const ks = [], sc = [];
        const k = new Keys((vk, dn) => ks.push(vk), () => {}, null, null, (n) => sc.push(n));
        k.wheel = true; k.feed(100, 0, 0); k.feed(102, 0, 0); k.feed(101, 0, 0);
        assert.deepStrictEqual([sc, ks], [[-2, 1], []], 'wheel notches, no keys');
        k.wheel = false; k.feed(102, 0, 0);
        assert.deepStrictEqual(ks, [40, 40], 'games: Down key again');
    }
    {   // strict parked check: a dead speed subscription (no reading for 5 s) counts as moving
        const P = require(path.join(SRC, 'kit', 'parked'));
        let h = null;
        const p = P.watch({ signals: { watch: (i, n, hs) => { h = hs; return Promise.resolve({}); } } }, null, { strict: true });
        assert.strictEqual(p.moving(), true, 'no speed yet: moving');
        h.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
        assert.strictEqual(p.moving(), false, 'fresh 0 km/h: parked');
        const now = Date.now; Date.now = () => now() + P.STALE_MS + 1;
        try { assert.strictEqual(p.moving(), true, 'a stale 0 km/h: moving'); } finally { Date.now = now; }
    }
    clearInterval(speedT);
    const errs = logs.filter((l) => l[0] === 'E');
    assert.deepStrictEqual(errs, [], 'no errors logged');
    console.log('smoke: all checks passed (' + process.version + ')');
    process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.error(logs.slice(-30).join('\n')); process.exit(1); });
