'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * moonlightd.js - the control plane on the car (Node 22, jap-node22)
 * Serves the ctl socket to the OAP app (Node 8), runs pairing/launch/cancel (gs.js), spawns the native
 * `mgu-moonlight stream` for each session and bridges the pad page to the private BT helper.
 *
 * Environment (defaults are the car's):
 *   MGU_STATE  /var/opt/jap-moonride          key.pem, cert.pem, server.json, settings.json
 *   MGU_COVERS /var/opt/jap-moonride/covers   the apps' box art for the app (readable by its group)
 *   MGU_BIN    /var/opt/jap-moonride/current/mgu-moonlight
 *   MGU_CTL    /run/jap-moonride/ctl.sock      MGU_BT /run/jap-moonride/bt.sock
 *   MGU_AUDIO  null | wav:PATH | alsa:DEVICE    MGU_DECODER msdk | null
 *   MGU_DUMP   FILE.h264: each stream's video as received (testing: what the car gets)
 *
 * App -> daemon: {"cmd":"status"} {"cmd":"pair","host":"192.0.2.10"} {"cmd":"applist"}
 *   {"cmd":"start","app":N,"w":1920,"h":720,"fps":60,"kbps":10000} {"cmd":"stop"}
 *   {"cmd":"touch","phase":1|2|3,"x":..,"y":..} {"cmd":"key","vk":13,"down":true}
 *   {"cmd":"mouse","dx":..,"dy":..} (relative) {"cmd":"btn","btn":1|2|3,"down":true} (left, middle, right) {"cmd":"scroll","n":1}
 *   {"cmd":"pads","op":"scan","on":true} {"cmd":"pads","op":"pair"|"forget","addr":".."} {"cmd":"pads","op":"list"}
 *   {"cmd":"padtest","on":true}   the USB pad's state while no stream holds it (the pads page's tester, the cards' navigation)
 * Daemon -> app: {"ev":"state",...} {"ev":"pin","pin":"1234"} {"ev":"apps","apps":[{id,title,cover?}]} {"ev":"stats",..}
 *   {"ev":"cover","id":N,"path":"..","w":360,"h":540}   cover (in apps too, once cached): raw RGBA, w*h*4 bytes
 *   {"ev":"pads","msg":{...helper event...}} {"ev":"error","msg":".."}
 *   {"ev":"padtest","b":buttons,"lt","rt","lx","ly","rx","ry"} (XInput values) or {"ev":"padtest","gone":true}
 * Rules: the last app connection closing stops the stream within 1 s; every stop quits the app on the host
 * (Vibepollo's undo commands run on quit, not on a bare disconnect); never exits on an error.
 */
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const { GameStream } = require('./gs');
const png = require('./png');
const relay = require('./relay');

const STATE = process.env.MGU_STATE || '/var/opt/jap-moonride';
const BIN = process.env.MGU_BIN || '/var/opt/jap-moonride/current/mgu-moonlight';
const CTL = process.env.MGU_CTL || '/run/jap-moonride/ctl.sock';
const BT = process.env.MGU_BT || '/run/jap-moonride/bt.sock';
const AUDIO = process.env.MGU_AUDIO || 'null';
const DECODER = process.env.MGU_DECODER || 'msdk';
const DUMP = process.env.MGU_DUMP || '';
const SETTINGS = path.join(STATE, 'settings.json');
const COVERS = process.env.MGU_COVERS || '/var/opt/jap-moonride/covers';
// the app's card (210 x 315 on its 1600 px page) in screen px (the page is drawn 1920 px wide): drawn 1:1 there
const COVER_W = 360, COVER_H = 540, COVER_END = '-' + COVER_W + 'x' + COVER_H + '.rgba';
const COVER_GAP_MS = 300;
const REMOTE_KBPS = +process.env.MGU_REMOTE_KBPS || 6000;   // the cap through Tailscale            // between two covers: the fetches yield to everything else

const log = (...a) => console.log(new Date().toISOString(), ...a);
const clients = new Set();
const broadcast = (o) => { const l = JSON.stringify(o) + '\n'; for (const c of clients) c.write(l); };
let state = 'idle', child = null, gs = null, stream = null, pairing = false;

function setState(s, extra) { state = s; broadcast(Object.assign({ ev: 'state', state: s }, extra || {})); if (s === 'idle') coverNext(); }
function settings() { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return {}; } }
function saveSettings(s) { fs.writeFileSync(SETTINGS + '.tmp', JSON.stringify(s)); fs.renameSync(SETTINGS + '.tmp', SETTINGS); }
function host() {
    const h = settings().host;
    if (!h) throw new Error('no host yet: pair first');
    return gs && gs.host === h ? gs : (gs = new GameStream({ host: h, dir: STATE }));
}
/** g.via: direct on the local network, else through Tailscale (relay.js). Probed again after 15 s. */
let reachT = 0;
async function reach(g) {
    if (Date.now() - reachT < 15000 && (relay.target === g.host) === !!g.via) return g;
    reachT = Date.now();
    if (await relay.direct(g.host)) { relay.stop(); g.via = null; }
    else { relay.start(g.host); g.via = relay.LOCAL; }
    return g;
}
function ensureIdentity() {
    if (!fs.existsSync(path.join(STATE, 'key.pem'))) execFileSync(BIN, ['mkcert', STATE]);
}

async function pair(h) {
    if (pairing) throw new Error('a pairing is already waiting');
    if (state !== 'idle') throw new Error('stop the stream before pairing');   // the exit handler must quit the old host
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) throw new Error('host must be an IPv4 address');
    ensureIdentity();
    pairing = true;
    try {
        const g = await reach(new GameStream({ host: h, dir: STATE }));
        const info = await g.serverinfo();
        if (!info.paired) {
            const pin = String(crypto.randomInt(10000)).padStart(4, '0');
            broadcast({ ev: 'pin', pin, hostname: info.hostname });
            await g.pair(pin);
        }
        saveSettings(Object.assign(settings(), { host: h }));
        gs = g;
        coverSeen.clear(); coverQ.length = 0;   // another host: its own covers
        broadcast({ ev: 'paired', host: h, hostname: info.hostname });
    } finally { pairing = false; }
}

const int = (v, lo, hi, def) => { const n = v == null ? def : Math.round(Number(v)); if (!(n >= lo && n <= hi)) throw new Error('value out of range'); return n; };

async function start(m) {
    if (child || state !== 'idle') throw new Error('already ' + state);   // a double tap must not touch the live stream
    const g = await reach(host());
    const app = int(m.app, 1, 0x7fffffff), w = int(m.w, 320, 1920, 1920), h = int(m.h, 240, 1080, 720);
    const fps = int(m.fps, 10, 60, 60);
    let kbps = int(m.kbps, 500, 50000, 10000);
    padtest(false);   // the stream binary claims the pad (it retries until the tester let go)
    setState('launching');
    let l;
    try {
        const launchParams = execFileSync(BIN, ['launchparams'], { encoding: 'utf8' }).trim();
        l = await g.launch({ app, w, h, fps, launchParams });
    } catch (e) {
        await quitHost();
        setState('idle');
        throw e;
    }
    if (state !== 'launching' || !clients.size) {   // stopped, or the app went away, while the host launched
        await quitHost();
        return setState('idle');
    }
    const rtsp = g.via ? (l.rtsp || '').replace(/^(rtspe?n?c?:\/\/)[^:/]+/, '$1' + g.via) : l.rtsp || '';   // the RTSP URL names the PC
    const args = ['stream', '--host', g.via || g.host, '--rtsp', rtsp, '--appver', l.info.appversion, '--gfever', l.info.gfeversion,
        '--codecs', String(l.info.codecs), '--rikey', l.rikey, '--rikeyid', String(l.rikeyid), '--w', String(w), '--h', String(h),
        '--fps', String(fps), '--kbps', String(kbps), '--decoder', DECODER, '--audio', m.audio === 'off' ? 'null' : AUDIO, '--pads', BT].concat(g.via ? ['--packet', '1024'] : [], ['--codec', m.codec === 'hevc' || (m.codec !== 'h264' && g.via) ? 'hevc' : 'h264'], DUMP ? ['--dump', DUMP] : []);   // 1024: under WireGuard's 1280 MTU
    if (g.via) kbps = Math.min(kbps, REMOTE_KBPS);   // away (5G / 4G): a lower rate loses fewer packets on the mobile link
    stream = { w, h, since: Date.now(), kbps, remote: !!g.via };
    const c = child = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let ended = false;
    const end = (code) => {
        if (ended) return;
        ended = true;
        log('stream exited', code);
        child = null; stream = null;
        quitHost().then(() => { setState('idle', { code }); for (const r of exitWaiters.splice(0)) r(); });
    };
    let buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let e; try { e = JSON.parse(line); } catch (x) { continue; }
            if (e.ev === 'quit') { log('quit combo'); stop(); continue; }   // the pad's View + Menu held
            if (e.ev === 'state' && e.state === 'streaming') setState('streaming');
            else if (e.ev !== 'state') broadcast(e);
        }
    });
    c.on('exit', end);
    c.on('error', (e) => { log('spawn failed:', e.message); end(-1); });
    c.stdin.on('error', () => {});
}

const exitWaiters = [];
/** Resolves once the streamer is gone and the host app was quit. */
function stop() {
    if (state === 'launching') return setState('stopping'), Promise.resolve();   // start() sees it after /launch and quits
    if (!child) return quitHost();
    setState('stopping');
    child.stdin.write('stop\n');
    const c = child;
    setTimeout(() => { if (child === c) c.kill('SIGKILL'); }, 3000);   // its exit handler quits the host app
    return new Promise((r) => exitWaiters.push(r));
}

function quitHost() {
    try { return host().cancel().catch((e) => log('cancel failed:', e.message)); } catch (e) { return Promise.resolve(); }
}

function input(m) {
    if (!child || !stream) return;
    const w = (s) => child.stdin.write(s + '\n');
    if (m.cmd === 'touch') {
        w('pos ' + Math.round(m.x) + ' ' + Math.round(m.y));
        if (m.phase === 1) w('btn 1 1');
        if (m.phase === 3) w('btn 1 0');
    } else if (m.cmd === 'key') w('key ' + (m.vk | 0) + ' ' + (m.down ? 1 : 0));
    else if (m.cmd === 'mouse') w('move ' + Math.max(-32768, Math.min(32767, m.dx | 0)) + ' ' + Math.max(-32768, Math.min(32767, m.dy | 0)));
    else if (m.cmd === 'scroll') w('scroll ' + Math.max(-10, Math.min(10, m.n | 0)));
    else if (m.cmd === 'btn' && [1, 2, 3].indexOf(m.btn) >= 0) w('btn ' + m.btn + ' ' + (m.down ? 1 : 0));
}

/* ---- covers: the host's box art, cached as the app draws it ----
 * After each applist the apps whose cover was not checked in this run are fetched one by one, only while idle
 * (a start or a pairing pauses the queue; idle resumes it). File <id>-<crc32 of the PNG>-<w>x<h>.rgba: a cover
 * changed on the host gets a new name (fetched again once per daemon run), the same bytes are not decoded again. */
const coverQ = [], coverSeen = new Set();
let coverBusy = false;
function coverFiles() { try { return fs.readdirSync(COVERS); } catch (e) { return []; } }
function withCovers(apps) {
    const ids = new Set(apps.map((a) => String(a.id)));
    coverPrune((f) => !ids.has(f.split('-')[0]));       // apps the host no longer lists
    const files = coverFiles();
    for (const a of apps) {
        const f = files.find((n) => n.startsWith(a.id + '-') && n.endsWith(COVER_END));
        if (f) a.cover = { path: path.join(COVERS, f), w: COVER_W, h: COVER_H };
    }
    for (const a of apps) if (!coverSeen.has(a.id) && coverQ.indexOf(a.id) < 0) coverQ.push(a.id);
    setImmediate(coverNext);
    return apps;
}
async function coverNext() {
    if (coverBusy) return;
    coverBusy = true;
    try {
        while (coverQ.length && state === 'idle' && !pairing) {
            const id = coverQ.shift();
            try { await coverOne(id); } catch (e) { log('cover', id, 'failed:', e.message); }
            await new Promise((r) => setTimeout(r, COVER_GAP_MS));
        }
    } finally { coverBusy = false; }
}
async function coverOne(id) {
    const r = await (await reach(host())).asset(id);
    coverSeen.add(id);                   // (a network error above: tried again at the next applist)
    // shortcut: PNG only (all Vibepollo serves, also for its default art); a JPEG cover keeps the gradient card
    if (!/png/i.test(r.type)) throw new Error('not a PNG: ' + r.type);
    const name = id + '-' + zlib.crc32(r.buf).toString(16).padStart(8, '0') + COVER_END, file = path.join(COVERS, name);
    if (fs.existsSync(file)) return;
    const px = png.fit(png.decode(r.buf), COVER_W, COVER_H);
    fs.mkdirSync(COVERS, { recursive: true });
    fs.writeFileSync(file + '.tmp', px, { mode: 0o644 });
    fs.renameSync(file + '.tmp', file);
    broadcast({ ev: 'cover', id, path: file, w: COVER_W, h: COVER_H });
    coverPrune((f) => f.startsWith(id + '-') && f !== name);
}
function coverPrune(drop) { for (const f of coverFiles()) if (drop(f)) try { fs.unlinkSync(path.join(COVERS, f)); } catch (e) { /* gone */ } }

/* ---- the BT helper: one long-lived client for the pad page (the stream binary has its own) ---- */
let bt = null, btWait = 500, dongle = null;   // the helper's last `dongle` event, for apps that connect later
function btConnect() {
    const s = net.createConnection(BT);
    let buf = '';
    s.setEncoding('utf8');
    s.on('connect', () => { bt = s; btWait = 500; });
    s.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let e; try { e = JSON.parse(line); } catch (x) { continue; }
            if (e.ev === 'dongle') dongle = e;
            if (e.ev !== 'state') broadcast({ ev: 'pads', msg: e });   // pad input goes to the stream binary directly
        }
        if (buf.length > 1 << 16) buf = '';
    });
    s.on('error', () => {});
    s.on('close', () => { bt = null; dongle = null; setTimeout(btConnect, btWait); btWait = Math.min(10000, btWait * 2); });
}
function pads(m) {
    if (!bt) throw new Error('Bluetooth helper not running');
    const addr = String(m.addr || '');
    if (m.op === 'scan') bt.write('scan ' + (m.on ? 'on' : 'off') + '\n');
    else if (m.op === 'list') bt.write('list\n');
    else if ((m.op === 'pair' || m.op === 'forget') && /^[0-9A-Fa-f:]{17}$/.test(addr)) bt.write(m.op + ' ' + addr + '\n');
    else throw new Error('bad pads command');
}

/* ---- the pad outside a stream: `mgu-moonlight padtest` prints its state (the app's tester and navigation) ---- */
let tester = null;
function padtest(on) {
    if (!on || child || state !== 'idle') { if (tester) tester.kill(); return; }   // a stream claims the pad itself
    if (tester) return;
    const t = tester = spawn(BIN, ['padtest', '86400'], { stdio: ['ignore', 'pipe', 'ignore'] }), born = Date.now();
    let buf = '';
    t.stdout.setEncoding('utf8');
    t.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let e; try { e = JSON.parse(line); } catch (x) { continue; }
            if (e.ev === 'pad') broadcast(Object.assign(e, { ev: 'padtest' }));
        }
        if (buf.length > 1 << 16) buf = '';
    });
    t.on('error', (e) => log('padtest spawn failed:', e.message));
    t.on('exit', () => {
        if (tester !== t) return;
        tester = null;
        broadcast({ ev: 'padtest', gone: true });
        if (Date.now() - born > 5000) setTimeout(() => { if (clients.size) padtest(true); }, 1000);   // not a crash loop: back on
    });
}

async function handle(c, m) {
    switch (m.cmd) {
    case 'status': return c.write(JSON.stringify({ ev: 'state', state, host: settings().host || null, stream, bt: !!bt }) + '\n') && dongle && c.write(JSON.stringify({ ev: 'pads', msg: dongle }) + '\n');
    case 'pair': return pair(m.host);
    case 'applist': return broadcast({ ev: 'apps', apps: withCovers(await (await reach(host())).applist()) });
    case 'start': return start(m);
    case 'stop': return stop();
    case 'touch': case 'key': case 'mouse': case 'btn': case 'scroll': return input(m);
    case 'pads': return pads(m);
    case 'padtest': return padtest(!!m.on);
    default: throw new Error('unknown cmd');
    }
}

function serve() {
    try { fs.unlinkSync(CTL); } catch (e) { /* none */ }
    const srv = net.createServer((c) => {
        clients.add(c);
        c.setEncoding('utf8');
        let buf = '';
        c.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                let m; try { m = JSON.parse(line); } catch (e) { continue; }
                if (!m || typeof m.cmd !== 'string') continue;
                handle(c, m).catch((e) => { log(m.cmd, 'failed:', e.message); broadcast({ ev: 'error', cmd: m.cmd, msg: e.message }); });
            }
            if (buf.length > 1 << 16) buf = '';
        });
        c.on('error', () => {});
        c.on('close', () => { clients.delete(c); if (!clients.size) padtest(false); if (!clients.size && child) { log('last app connection gone: stop'); stop(); } });
    });
    srv.on('error', (e) => log('ctl listen failed:', e.message));
    // created 0660 (umask 0117 while it binds): no moment where others could connect before the chmod
    const umask = process.umask(0o117);
    srv.listen(CTL, () => { try { fs.chmodSync(CTL, 0o660); } catch (e) { /* tmpfs without chmod */ } log('ctl on', CTL); });
    process.umask(umask);
}

process.on('uncaughtException', (e) => log('uncaught:', e.stack || e));
process.on('unhandledRejection', (e) => log('unhandled:', e && e.stack || e));
process.on('SIGTERM', () => { stop().then(() => process.exit(0)); setTimeout(() => process.exit(0), 4000); });
serve();
btConnect();
