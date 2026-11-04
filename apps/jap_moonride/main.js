'use strict';
/**
 * Moonride - stream a game from the PC (Sunshine / Vibepollo) over the whole screen, parked only.
 * The jap-moonride tool does the work (moonlightd.js, Node 22: pairing, launch, the native decoder that
 * writes /dev/shm/mgu-video-jap-moonride, the pads); this app is its face, over ctl.js.
 *
 * Screens:
 *   MAIN  drawn (view.js), two pages:
 *           home  title, the host's status (green: name + RTT, orange: pairing, grey: not paired / PC not
 *                 found), "•••" (opens Manettes, Settings and the hints; 15 s, or a card focused, closes it); the host's apps as big cards (tap or press = start), then
 *                 Actualiser (applist) and Jumeler (pair with host1..4); Stop while a stream starts or stops.
 *                 A card shows the app's box art once the daemon has it ({"ev":"cover"}: raw RGBA in its cache dir),
 *                 read when the card is first drawn, from a few picture ids reused (least recently drawn).
 *                 While pairing, the PIN sheet over it (the code and https://<host>:47990/pin).
 *           pads  "Manettes": the 8BitDo USB adapter (the main case: it sends no state, so none is shown),
 *                 the pads the Bluetooth helper knows (battery %; tap twice = forget) and, with the helper,
 *                 its dongle, scan on / off and the devices found (tap = pair). Close, or the controller
 *                 pushed left, goes back home.
 *         Where the kit runs the screen (mgu-render/1 with touch: display.js) the page's targets take taps and
 *         the iDrive controller (turn = next card, push = nearest that way, press = run it; the kit rings the
 *         one it is on and tells us, ctx.onPageFocus, so the row scrolls it into view). Elsewhere (the HMI shows
 *         the page as a PNG) the bar's buttons do it: Suivant / Ouvrir, Manettes, Settings.
 *         Settings (host1..4 = the host's IPv4, resolution, bitrate, parkedOnly): the kit's (its sheet over the
 *         page, or the HMI's settings screen), from the round button or the header's Settings tab.
 *   GAME  the stream on the whole screen: the app's own mgu-render connection (mgu_render_client.js, native
 *         dialect: layer mode, PLACE + CLAIM the whole screen, VIDEO id 1, op 19). MAIN is the first canvas
 *         screen, so the kit's display (its own renderer connection) draws MAIN only, never GAME.
 *         Touch -> {"cmd":"touch"} in stream px, the iDrive controller -> {"cmd":"key"} (input.js).
 *         Setting "stats" (or the controller pressed 3 s, input.js): Moonlight's performance overlay over the video
 *         (view.stats), recorded again only when a stats line comes (once a second) or it is turned on / off.
 *         BACK (or anything that hides GAME) -> {"cmd":"stop"}, DROP_VIDEO, SHOW 0; the HMI is back on MAIN.
 *
 * Safety: with "parkedOnly" (on by default; turned back on if switched off while moving) the
 * stream stops above 3 km/h and Start is refused; no speed reading counts as moving (parked.js strict).
 * Never exits: errors are logged (MainApp wipes the app's data at its first crash, uninstalls it at the second).
 */
const fs = require('fs');
const mgu = require('./kit/mgu');
const Parked = require('./kit/parked');
const record = require('./kit/record');
const { setImage, Recorder } = record;
const { Ctl } = require('./ctl');
const { toStream, Keys, Touchpad, ScreenTouch } = require('./input');
const { RenderClient } = require('./mgu_render_client');
const view = require('./view');

const VID = 1, VPATH = process.env.MGU_MOONLIGHT_VIDEO || '/dev/shm/mgu-video-jap-moonride';
const MAX_APPS = 48;                 // cards in the row (a host lists a few; this bounds a strange one)
const MAX_PADS = 8;                  // pad rows on the pads page
const KEEPALIVE_MS = 500;            // the renderer hides an app silent for 3 s
const FORGET_MS = 5000;              // a second tap within this forgets the pad
const PIC0 = 8, PICS = 12;           // cover picture ids PIC0..: more than the cards drawn at once (SHOWN + 2)
const MENU_MS = 15000;               // the "•••" menu closes by itself after this long untouched
// bar buttons: where the kit runs the screen the page has their jobs (hidden there)
const BAR = ['BTN_NEXT', 'BTN_OK', 'BTN_PADS'];

const say = (e) => (e && e.stack) || String(e);
process.on('uncaughtException', (e) => { try { mgu.log.error('uncaught', e); } catch (x) { /* nothing left to log with */ } });
process.on('unhandledRejection', (e) => { try { mgu.log.error('unhandled rejection: ' + say(e)); } catch (x) { /* idem */ } });

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const safe = (what, fn) => function () { try { return fn.apply(null, arguments); } catch (e) { log.error(what, e); } };

        /* ---------- parked only ---------- */
        const parked = Parked.watch(ctx, log, { strict: true });
        // on by default; off is the owner's choice, at their own risk (a passenger plays). Not settable off while moving.
        const driving = () => settings.get('parkedOnly') !== false && parked.moving();
        // turning it off asks first (st.risk: the disclaimer sheet); the acceptance is kept beside the settings
        // (_parkedOffAccepted, no schema entry) and dropped when parkedOnly is turned back on
        const ACCEPTED = '_parkedOffAccepted';
        // off without the acceptance on record (an old settings file, a hand edit): back on
        if (settings.get('parkedOnly') === false && settings.get(ACCEPTED) !== true) settings.set('parkedOnly', true);
        settings.onChange((k, v) => {
            if (k === 'parkedOnly' && v === false && parked.moving()) {
                log.warn('parkedOnly: cannot be turned off while moving');
                settings.set('parkedOnly', true);
            } else if (k === 'parkedOnly' && v === false && settings.get(ACCEPTED) !== true) {
                st.risk = true;                     // not applied: on until "I accept"
                settings.set('parkedOnly', true);
            } else if (k === 'parkedOnly' && v === true && settings.get(ACCEPTED) === true && !st.risk) {
                settings.set(ACCEPTED, false);
            }
            if (k === 'stats') redrawGame();
            refresh();
        });

        /* ---------- the daemon ---------- */
        const st = { up: false, state: 'idle', host: null, hostname: null, bt: null, error: null, pin: null, apps: [], stats: null, offline: false };
        const pads = { dongle: null, dmsg: '', scan: false, bonded: new Map(), conn: new Map(), battery: {}, found: new Map(), note: '', armed: null, test: null };
        const ctl = new Ctl(log);
        const hostIp = () => [1, 2, 3, 4].map((i) => Number(settings.get('host' + i)) | 0).join('.');
        ctl.on('up', safe('ctl up', () => { st.up = true; st.error = null; ctl.send({ cmd: 'status' }); ctl.send({ cmd: 'padtest', on: true }); refresh(); }));
        ctl.on('down', safe('ctl down', () => { st.up = false; st.state = 'idle'; st.pin = null; refresh(); }));
        ctl.on('msg', safe('ctl msg', (m) => {
            if (m.ev === 'state') {
                const was = st.state;
                // connected is not a picture yet: the loading screen stays until the first frame is shown (stats)
                st.daemon = m.state;
                if (m.state !== 'streaming') st.frame = false;
                st.state = m.state === 'streaming' && !st.frame ? 'launching' : m.state;
                if (st.state === 'launching' && m.state === 'streaming' && !st.frameT) st.frameT = setTimeout(safe('first frame', () => showGame('no frame in ' + FRAME_WAIT_MS / 1000 + ' s')), FRAME_WAIT_MS);
                if ('host' in m) {                                   // the status reply
                    st.host = m.host; st.bt = !!m.bt;
                    if (m.host && !st.apps.length) ctl.send({ cmd: 'applist' });
                }
                if (m.state === 'streaming') { st.error = null; st.pin = null; st.launch = null; }
                if (m.state === 'idle' && was !== 'idle') { st.launch = null; ctl.send({ cmd: 'padtest', on: true }); }   // ended, failed or cancelled: the pad back on the cards
                if (m.state === 'idle' && was !== 'idle') { st.stats = null; if (ui.isVisible('GAME')) ui.open('MAIN'); }
                log.info('moonlightd: ' + m.state + (m.code != null ? ' (code ' + m.code + ')' : ''));
            } else if (m.ev === 'pin') st.pin = m.pin;
            else if (m.ev === 'paired') { st.pin = null; st.host = m.host; st.hostname = m.hostname || null; st.error = null; ctl.send({ cmd: 'applist' }); }
            else if (m.ev === 'apps') { st.offline = false; st.apps = (Array.isArray(m.apps) ? m.apps : []).filter((a) => a && a.id != null).slice(0, MAX_APPS); }
            else if (m.ev === 'cover') { const a = st.apps.find((x) => x.id === m.id); if (!a) return; a.cover = { path: m.path, w: m.w, h: m.h }; }
            else if (m.ev === 'stats') {             // (each second: MAIN redrawn only for a new RTT, GAME with the overlay on)
                if (!st.frame && st.daemon === 'streaming' && m.shown > 0) showGame('first frame');
                if (!st.stats || st.stats.rtt !== m.rtt) dirty = true;
                st.stats = m;
                if (settings.get('stats')) redrawGame();
                return;
            }
            else if (m.ev === 'pads') padMsg(m.msg || {});
            else if (m.ev === 'padtest') { padNav(pads.test, m.gone ? null : m); pads.test = m.gone ? null : m; }
            else if (m.ev === 'error') {
                log.warn('moonlightd: ' + (m.cmd || '') + ': ' + m.msg);
                if (m.cmd === 'start') st.launch = null;
                if (m.cmd === 'pads') { pads.note = m.msg; } else {
                    st.error = m.msg;
                    if (m.cmd === 'pair') st.pin = null;
                    if (m.cmd === 'applist') st.offline = true;      // the host did not answer: "PC introuvable"
                }
            }
            refresh();
        }));
        ctl.connect();

        // the first picture: GAME over the loading screen (or after FRAME_WAIT_MS, should the stats say nothing)
        const FRAME_WAIT_MS = 20000;
        function showGame(why) {
            clearTimeout(st.frameT); st.frameT = null;
            if (st.frame || st.daemon !== 'streaming') return;
            st.frame = true; st.state = 'streaming';
            log.info('game shown: ' + why);
            if (driving()) return stop('car moving');
            ui.open('GAME');
            refresh();
        }
        // the car's speakers: the daemon plays the PC's sound into SmartX source CarLifeMedia (287, China only, so
        // free here); AudioManager routes it to the main speaker (1024) as Drive Recorder routes its own source.
        // 287 is A_UNAVAILABLE without a CarLife phone, and a connect to it stays CS_CONNECTING for ever: it is marked
        // available on the AudioManager's routing side while shown, unavailable again after (measured 04/11: then
        // CS_CONNECTED in < 1 s and the port is read in real time).
        // One connect per shown game, one disconnect after it, in order (am.q).
        const AM = 'org.genivi.am.commandinterface.CommandControl', AMR = 'org.genivi.am.routinginterface.RoutingControlObserver';
        const AM_SRC = 287, AM_SINK = 1024;
        const am = { p: null, r: null, id: null, on: false, q: Promise.resolve(), swept: false };
        // a fresh proxy answers "Service unavailable" until the provider is found: wait for it (max 5 s)
        async function amProxy(iface) {
            const p = await ctx.signals.proxy(iface, '1');
            await new Promise((res) => { const t = setTimeout(res, 5000); ctx.signals.onAvailable(p, (a) => { if (a) { clearTimeout(t); res(); } }); });
            return p;
        }
        const avail = (on) => ctx.signals.call(am.r, 'hookSourceAvailablityStatusChange',
            { sourceID: AM_SRC, availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 } })
            .then(() => log.info('car audio: source ' + (on ? 'available' : 'unavailable')), (e) => log.warn('car audio availability: ' + e));
        // a 287 connection left by a connect timeout, a crash or a shutdown (as yt's dropLeftovers): disconnected
        async function sweep() {
            const r = await ctx.signals.call(am.p, 'getListMainConnections', {});
            if (!am.swept) { am.swept = true; log.info('car audio connections: ' + JSON.stringify(r).slice(0, 600)); }   // the reply's shape, once
            const list = Array.isArray(r) ? r : (r && Object.values(r).find(Array.isArray)) || [];
            for (const c of list.filter((c) => c && c.sourceID === AM_SRC))
                log.info('car audio: leftover ' + c.mainConnectionID + ' ' + JSON.stringify(await ctx.signals.call(am.p, 'disconnect', { mainConnectionID: c.mainConnectionID })));
        }
        // at start: what a crash or a power-off left (a 287 connection, the source marked available) goes
        am.q = am.q.then(async () => {
            am.p = await amProxy(AM);
            am.r = await amProxy(AMR);
            await sweep().catch((e) => log.warn('car audio sweep: ' + e));
            await avail(false);
        }).catch((e) => log.warn('car audio start: ' + e));
        function carAudio(on) {
            if (on === am.on) return;
            am.on = on;
            am.q = am.q.then(async () => {
                if (!am.p) {
                    am.p = await amProxy(AM);
                    am.r = await amProxy(AMR);
                    await sweep().catch((e) => log.warn('car audio sweep: ' + e));
                }
                if (on) {
                    await avail(true);
                    const r = await ctx.signals.call(am.p, 'connect', { sourceID: AM_SRC, sinkID: AM_SINK });
                    log.info('car audio: connect ' + JSON.stringify(r));
                    const ok = r && (r.amError === 'E_OK' || r.amError === 'E_ALREADY_EXISTS' || r.amError === 0);
                    am.id = ok && r.mainConnectionID != null ? r.mainConnectionID : null;
                    if (!ok) log.warn('car audio: connect refused');
                    else setTimeout(() => ctx.signals.call(am.p, 'getListMainConnections', {}).then((l) => {
                        const c = ((l && l.listConnections) || []).find((c) => c.sourceID === AM_SRC);
                        log.info('car audio: ' + (c ? c.connectionState : 'no connection'));
                    }, () => {}), 1500);
                } else {
                    if (am.id != null) {
                        const r = await ctx.signals.call(am.p, 'disconnect', { mainConnectionID: am.id });
                        log.info('car audio: disconnect ' + JSON.stringify(r));
                        am.id = null;
                    } else await sweep();   // connect timed out or gave no id: whatever 287 has goes
                    await avail(false);
                }
            }).catch((e) => log.warn('car audio: ' + e));
        }
        let stopT = 0;
        function stop(why) {
            if (Date.now() - stopT < 2000) return;          // the sync loop asks every 250 ms: once is enough
            stopT = Date.now();
            log.info('stop: ' + why);
            ctl.send({ cmd: 'stop' });
        }
        const live = () => st.state === 'launching' || st.state === 'streaming';

        /* ---------- Tailscale (the jap-tailscale tool): its login link, shown as a QR code while it needs one ---------- */
        const TSPUB = process.env.MGU_TAILSCALE_PUB || '/run/jap-tailscale/pub';
        st.tsUrl = null; st.tsSheet = false;
        function readTs() {
            let u = '';
            try { u = fs.readFileSync(TSPUB + '/login-url', 'utf8').trim(); } catch (e) { /* no tool, or logged in */ }
            u = /^https:\/\/[!-~]+$/.test(u) && u.length <= 62 ? u : null;     // 62: what the QR code holds
            if (u === st.tsUrl) return;
            st.tsUrl = u; if (!u) st.tsSheet = false;
            refresh();
        }

        /* ---------- MAIN: what the page's targets (and the bar) do ---------- */
        let mode = 'home', menu = false, menuTimer = null, focus = null, first = 0, padSy = 0, dirty = true, padsLabel = null;
        function refresh() {
            dirty = true;
            const l = mode === 'pads' ? 'Accueil' : 'Manettes';       // (the HMI's bar: told only on a change)
            if (l !== padsLabel) { padsLabel = l; ui.text('BTN_PADS', l); }
        }
        const act = {
            riskAccept: () => {
                st.risk = false;
                if (parked.moving()) { st.error = 'Stationné uniquement : réglage impossible tant que la voiture roule'; return refresh(); }
                settings.set(ACCEPTED, true);
                settings.set('parkedOnly', false);
                log.warn('parkedOnly off: the owner accepted the disclaimer');
                refresh();
            },
            riskCancel: () => { st.risk = false; refresh(); },
            tslogin: () => { st.tsSheet = !!st.tsUrl && !st.tsSheet; refresh(); },
            start: (a) => {
                if (driving()) { st.error = parked.speed() === null ? 'Stationné uniquement : vitesse du véhicule illisible, démarrage refusé' : 'Stationné uniquement : démarrage refusé tant que la voiture roule'; return refresh(); }
                if (live()) { st.error = 'Un stream tourne déjà : arrête-le d\'abord'; return refresh(); }
                const r = String(settings.get('res') || '1920x720').split('x').map(Number);
                st.error = null;
                st.launch = { app: a, t: Date.now() };   // the loading page until the stream shows (or it fails)
                keys.wheel = view.isDesktop(a);          // the Desktop: the knob turns the mouse wheel
                ctl.send({ cmd: 'start', app: a.id, w: r[0] || 1920, h: r[1] || 720, fps: 60, kbps: Number(settings.get('kbps')) || 8000, codec: settings.get('codec') || 'auto', audio: settings.get('audio') === 'off' ? 'off' : 'car' });
                log.info('start ' + a.id + ' ' + r.join('x'));
                refresh();
            },
            pair: () => {
                const h = hostIp();
                if (!st.up) { st.error = 'L\'outil jap-moonride ne tourne pas'; return refresh(); }
                // no default host: the owner sets the PC's address in Settings first
                if (h === '0.0.0.0') { st.error = 'Règle d\'abord l\'adresse IP du PC dans les réglages (Host IP)'; return refresh(); }
                st.error = null; st.pin = null; st.apps = []; st.offline = false; first = 0;
                ctl.send({ cmd: 'pair', host: h });
                log.info('pair ' + h);
                refresh();
            },
            refresh: () => { st.error = null; ctl.send({ cmd: 'applist' }); refresh(); },
            stop: () => stop('Stop'),
            menu: () => openMenu(!menu),
            pads: () => showPads(true),
            close: () => showPads(false),
            // the kit's Settings (its sheet over the page, or the HMI's screen): as a press of the bar's button
            settings: () => { const c = ui.rhmi && ui.rhmi.getByName('BTN_SETTINGS'); if (c && c.emit) c.emit('action', {}); },
            scan: () => {
                pads.scan = !pads.scan;
                if (pads.scan) pads.found.clear();
                padsCmd({ op: 'scan', on: pads.scan });
                refresh();
            },
            pad: (r) => {
                if (r.op === 'pair') { padsCmd({ op: 'pair', addr: r.addr }); pads.note = 'Association en cours (bouton d\'association de la manette)'; } else if (pads.armed !== r.addr) {
                    pads.armed = r.addr;
                    setTimeout(() => { if (pads.armed === r.addr) { pads.armed = null; refresh(); } }, FORGET_MS);
                } else {
                    pads.armed = null;
                    padsCmd({ op: 'forget', addr: r.addr });
                    pads.bonded.delete(r.addr);
                    pads.conn.forEach((c, idx) => { if (c.addr === r.addr) pads.conn.delete(idx); });
                }
                refresh();
            },
        };
        Object.keys(act).forEach((k) => { act[k] = safe(k, act[k]); });

        /* ---------- PADS (the pads page) ---------- */
        function padMsg(e) {
            if (e.ev === 'dongle') { pads.dongle = e.state; pads.dmsg = e.msg || ''; } else if (e.ev === 'found') {
                if (e.addr) pads.found.set(e.addr, { addr: e.addr, name: e.name || '', bonded: !!e.bonded });
            } else if (e.ev === 'bonded') { if (e.addr) pads.bonded.set(e.addr, e.transport || ''); } else if (e.ev === 'connected') {
                if (e.idx != null) pads.conn.set(e.idx, { addr: e.addr, name: e.name || '' });
                if (e.addr) pads.bonded.set(e.addr, e.transport || '');
            } else if (e.ev === 'disconnected') { pads.conn.delete(e.idx); delete pads.battery[e.idx]; } else if (e.ev === 'battery') pads.battery[e.idx] = e.pct;
            else if (e.ev === 'paired') { pads.note = 'Manette associée'; if (e.addr) { pads.bonded.set(e.addr, ''); pads.found.delete(e.addr); } } else if (e.ev === 'list_end') pads.note = '';
            else if (e.ev === 'error') pads.note = (e.cmd ? e.cmd + ' : ' : '') + e.msg;
        }
        // rows: the pads we know first (bonded or connected: tap twice = forget), then the scan's finds (tap = pair)
        function padRows() {
            const known = [];
            const byAddr = {};
            pads.conn.forEach((c, idx) => { byAddr[c.addr] = { idx, name: c.name }; });
            pads.bonded.forEach((t, addr) => known.push(addr));
            pads.conn.forEach((c) => { if (known.indexOf(c.addr) < 0) known.push(c.addr); });
            const rows = known.map((addr) => {
                const c = byAddr[addr], f = pads.found.get(addr), pct = c ? pads.battery[c.idx] : null;
                return { op: 'forget', addr, name: (c && c.name) || (f && f.name) || 'Manette', conn: !!c, pct: pct != null ? pct : null };
            });
            pads.found.forEach((f, addr) => { if (known.indexOf(addr) < 0) rows.push({ op: 'pair', addr, name: f.name || 'appareil' }); });
            return rows.slice(0, MAX_PADS);
        }
        const padsCmd = (o) => { pads.note = ''; ctl.send(Object.assign({ cmd: 'pads' }, o)); };
        // the USB pad outside a stream: left/right (d-pad or stick) along the cards, A plays, B goes back
        // shortcut: one step per push (no repeat while held), add a repeat if long lists need it
        function padNav(was, now) {
            if (!now || mode !== 'home' || st.pin || live() || ui.isVisible('GAME')) return;
            const b0 = was ? was.b : 0, x0 = was ? was.lx : 0;
            const hit = (bit) => (now.b & bit) && !(b0 & bit);
            const left = hit(0x4) || (now.lx < -16000 && x0 >= -16000), right = hit(0x8) || (now.lx > 16000 && x0 <= 16000);
            const keys = view.rowKeys(st.apps);
            if ((left || right) && keys.length) {
                const i = keys.indexOf(focus), j = i < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, i + (right ? 1 : -1)));
                focusOn(keys[j]);
                if (ctx.focus) ctx.focus(keys[j]);
                refresh();
            } else if (hit(0x1000)) {
                const a = st.apps.find((x) => 'app:' + x.id === focus);
                if (a) act.start(a); else if (focus === 'refresh') act.refresh(); else if (focus === 'pair') act.pair();
            } else if (hit(0x2000) && menu) openMenu(false);
        }
        // the "•••" menu (Manettes, Settings, the hints): closed, the page is the covers alone
        function openMenu(on) {
            clearTimeout(menuTimer);
            menu = on;
            if (on) menuTimer = setTimeout(safe('menu', () => openMenu(false)), MENU_MS);
            refresh();
        }
        function showPads(on) {
            if (on) openMenu(false);
            if (on && mode !== 'pads') { mode = 'pads'; padSy = 0; focus = null; pads.bonded.clear(); pads.conn.clear(); padsCmd({ op: 'list' }); }
            if (!on && mode === 'pads') {
                mode = 'home'; focus = null;
                if (pads.scan) { pads.scan = false; padsCmd({ op: 'scan', on: false }); }
            }
            refresh();
        }

        /* ---------- MAIN: the covers (read from the daemon's cache when a card draws one) ---------- */
        const pics = new Map();              // cover path -> { pid, t }
        let frameNo = 0;
        function picture(a) {
            const c = a.cover;
            if (!c || typeof c.path !== 'string') return null;
            let e = pics.get(c.path);
            if (!e) {
                let buf = null;
                try { buf = fs.readFileSync(c.path); } catch (x) { /* below */ }
                // a short file would make the renderer's upload read past it
                if (!buf || !(c.w > 0 && c.h > 0) || buf.length !== c.w * c.h * 4) { log.warn('cover ' + c.path + ': unreadable or not ' + c.w + 'x' + c.h); a.cover = null; return null; }
                if (pics.size < PICS) e = { pid: PIC0 + pics.size };
                else {
                    let old = null;
                    pics.forEach((x, k) => { if (!old || x.t < pics.get(old).t) old = k; });
                    e = pics.get(old); pics.delete(old);
                }
                setImage(e.pid, c.w, c.h, buf);
                pics.set(c.path, e);
            }
            e.t = frameNo;
            return e.pid;
        }

        /* ---------- MAIN: drawing and the controller ---------- */
        let targets = [], laid = { rowY: {} }, drivingWas = null, extra = 0;
        // drawn only when something changed (the kit sends the last frame again to keep the layer alive)
        function render() {
            if (driving() !== drivingWas) { drivingWas = driving(); dirty = true; }
            if (st.launch) dirty = true;    // the loading page moves
            if (!dirty) return null;
            dirty = false;
            frameNo++;
            const cv = ctx.canvas(view.W, view.H);
            const m = {
                mode, menu, st, pads, focus, first, padSy, ring: !cv.own, chrome: !!cv.chrome, extra: cv.own ? cv.extra : 0, host: hostIp(),
                res: String(settings.get('res') || '1920x720').replace('x', ' × ') + ' · 60 i/s', parkedOnly: settings.get('parkedOnly') === true,
                driving: driving(), noSpeed: parked.speed() === null, now: Date.now(), live: live() && !ui.isVisible('GAME'), padRows: mode === 'pads' ? padRows() : [], pic: picture, act,
            };
            view.draw(cv, m);
            extra = m.extra;                // (the row's size depends on it: how many cards show)
            laid = { rowY: m.rowY };
            targets = cv.targets.slice();
            return ui.image('MAIN_GFX', cv);
        }
        // the controller is on target key (null: elsewhere): keep it in view (the row of cards, the pads list)
        function focusOn(key) {
            if (key === focus) return;
            focus = key;
            // the controller back on the cards closes the menu; on its buttons it stays open
            if (menu) { if (/^app:/.test(key || '')) openMenu(false); else openMenu(true); }
            const i = view.rowKeys(st.apps).indexOf(key);
            if (mode === 'home' && i >= 0) {
                const n = view.shown(extra);
                if (i < first) first = i; else if (i > first + n - 1) first = i - n + 1;
            }
            const y = mode === 'pads' ? laid.rowY[key] : null;
            if (y != null) {
                const top = 132, bottom = view.H - 20;
                if (y - padSy < top) padSy = Math.max(0, y - top); else if (y + view.ROW_H - padSy > bottom) padSy = y + view.ROW_H - bottom;
            }
            dirty = true;
        }
        if (ctx.onPageFocus) ctx.onPageFocus(safe('focus', focusOn));
        // a finger dragged sideways scrolls the cards (the kit runs the screen); the controller still pages them
        if (ctx.onSwipe) ctx.onSwipe(safe('swipe', (dx) => {
            if (mode !== 'home' || st.pin) return false;
            const max = Math.max(0, view.rowKeys(st.apps).length - view.shown(extra));
            const f = Math.max(0, Math.min(max, first + dx / view.pitch(extra)));
            if (f === first) return false;
            first = f; dirty = true;
            return true;
        }));
        // the controller pushed left on the pads page: home (on home: the kit's own back, the app closes)
        if (ctx.onBack) ctx.onBack(safe('back', () => { if (mode !== 'pads') return false; showPads(false); return true; }));
        if (ctx.onLayout) ctx.onLayout(() => { dirty = true; });
        if (ctx.hideButton) BAR.forEach((b) => ctx.hideButton(b, true));
        // the HMI's bar (where the page can't be touched): Suivant moves along the targets, Ouvrir runs one
        ui.onClick('BTN_NEXT', safe('next', () => {
            if (!targets.length) return;
            const i = targets.findIndex((t) => t.key === focus);
            focusOn(targets[(i + 1) % targets.length].key);
        }));
        ui.onClick('BTN_OK', safe('ok', () => {
            const t = targets.find((x) => x.key === focus);
            if (t) t.run();
        }));
        ui.onClick('BTN_PADS', safe('pads', () => showPads(mode !== 'pads')));
        ctx.loop('MAIN', 10, render);
        ui.onVisible(safe('visible', (name, v) => {
            if (name === 'MAIN') { if (!v && mode === 'pads') showPads(false); refresh(); }
            if (name === 'GAME') { sync(); refresh(); }
        }));

        /* ---------- GAME: the renderer ---------- */
        const gpu = new RenderClient(ctx.spec.id, log, { kit: record });   // (kit: the overlay's glyph atlases)
        let shown = false, ino = null, lastMsg = 0, gameRec = null;   // gameRec: GAME's recording (frame())
        gpu.on('ready', safe('gpu ready', (screen, info) => {
            if (!info) return;                                  // not mgu-render/1: no video here
            gpu.mode('layer');
            gpu.place({ x: 0, y: 0, w: screen.w, h: screen.h, scale: 1, ox: 0, oy: 0 });
            gpu.claim([{ x: 0, y: 0, w: screen.w, h: screen.h }]);
            ino = null;                                         // the renderer forgot our video with the connection
            gameRec = null;
            log.info('mgu-render ' + screen.w + 'x' + screen.h + (info.video ? '' : ' (no video support!)'));
            sync();
        }));
        gpu.on('close', safe('gpu close', () => { ino = null; }));
        gpu.connect();
        const streamWH = () => { const r = String(settings.get('res') || '1920x720').split('x').map(Number); return { w: r[0] || 1920, h: r[1] || 720 }; };
        // GAME's frame: black, the video, the overlay; the same recording is sent again (keepalive) until redrawGame()
        function frame() {
            const pl = gpu.placement;
            if (!pl) return;
            if (!gameRec) {
                gameRec = new Recorder(pl.w, pl.h).clear(0x000000ff).video(VID, 0, 0, pl.w, pl.h, 0);
                if (settings.get('stats') && st.stats) view.stats(gameRec, st.stats);
            }
            gpu.frame(gameRec);
            lastMsg = Date.now();
        }
        function redrawGame() { gameRec = null; if (shown) frame(); }
        // touch on the layer -> stream pixels (the video is fitted into the whole layer, aspect kept: input.js), as
        // Jump Desktop's touch mode (input.js ScreenTouch); the daemon's touch phase 2 = the cursor only
        const screen = new ScreenTouch((x, y) => { if (shown) ctl.send({ cmd: 'touch', phase: 2, x, y }); },
            (b, down) => { if (shown) ctl.send({ cmd: 'btn', btn: b, down }); });
        let touches = 0;
        const onScreen = (ph, x, y) => {
            const phase = ['', 'down', 'move', 'up'][ph] || ph;   // renderd sends 1 down, 2 move, 3 up
            const pl = gpu.placement;
            if (phase === 'down' && touches++ < 5) log.info('screen touch ' + Math.round(x) + ',' + Math.round(y) + (shown ? '' : ' (not shown)') + (pl ? '' : ' (no placement)'));   // the first ones, for the car log
            if (!shown || !pl) return;
            const s = streamWH(), p = toStream(x, y, pl.w, pl.h, s.w, s.h);
            screen.feed(phase, p.x, p.y);
            return true;
        };
        gpu.on('touch', safe('touch', onScreen));
        // the kit's page shares the screen with the stream: the renderer may give a gesture to its claim, not ours
        if (ctx.onTouch) ctx.onTouch(safe('page touch', (ph, x, y) => shown && onScreen(ph, x, y)));
        // the iDrive controller: the renderer's copy while grabbed, else SOME/IP (Doom's two sources)
        const keys = new Keys((vk, down) => { if (shown) ctl.send({ cmd: 'key', vk, down }); },
            (btn, down) => { if (shown) ctl.send({ cmd: 'btn', btn, down }); },
            () => { if (shown) settings.set('stats', !settings.get('stats')); },
            () => { if (shown) { stop('knob held 6 s'); ui.open('MAIN'); } },
            (n) => { if (shown) ctl.send({ cmd: 'scroll', n }); });
        // the controller's touchpad = the mouse, in touch mode only (input.js Touchpad)
        const touchpad = new Touchpad((dx, dy) => { if (shown) ctl.send({ cmd: 'mouse', dx, dy }); },
            (b) => { if (shown) { ctl.send({ cmd: 'btn', btn: b, down: true }); ctl.send({ cmd: 'btn', btn: b, down: false }); } },
            (b, down) => { if (shown) ctl.send({ cmd: 'btn', btn: b, down }); });
        let padMode = -1, padT = 0;   // the pad's mode and when it last said so
        ctx.signals.watch('de.bmw.infotainment.ControllerElements', '1', {
            ZBETouchFrontSide: (v) => { padMode = v ? v.statusSystemModeFrontSide : -1; padT = Date.now(); touchpad.feed(v); },
        }, log).then((s) => log.info('touchpad ' + (s.error ? 'error: ' + s.error : 'subscribed')), (e) => log.error('touchpad', e));
        let ccuT = 0;
        gpu.on('ccu', safe('ccu', (v) => { ccuT = Date.now(); keys.feed(v.knob, v.press, v.tilt); }));
        ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU', '1', {
            statusRotaryEncoderState: (v) => {
                if (!v || Date.now() - ccuT <= 1000) return;
                keys.feed(v.frontRotaryEncoderOperation, v.frontRotaryEncoderPushButton, v.frontRotaryEncoderDeflection);
            },
        }, log).then((s) => {
            ccu.proxy = s.proxy; log.info('controller ' + (s.error ? 'error: ' + s.error : 'subscribed'));
            if (ccu.proxy) touchMode(false);    // once at start: a crash or power-off may have left touch mode on
        }, (e) => log.error('controller', e));
        // touch mode while the game shows: FrontCCU.ccsControlTouchCCU = TOUCH_AKTIV, as the HMI's speller sets it, and
        // TOUCH_NICHT_AKTIV again when it hides (the game is never shown while the speller is up). Asked again only when
        // the pad reports another mode after our write, 5 times a show at most: never a fight with the HMI.
        const ccu = { proxy: null, alive: 0, t: 0, asks: 0, fails: 0, on: false, restore: false };
        function touchMode(on) {
            const p = ccu.proxy;
            if (!p) return Promise.resolve();
            if (on && !ccu.on) ccu.asks = 0;
            if (on && ccu.asks >= 5) return Promise.resolve();
            if (on) ccu.asks++;
            ccu.on = on; ccu.t = Date.now();
            const v = { aliveControlTouchZBEFrontSide: ccu.alive = (ccu.alive + 1) % 15,
                controlTouchActiveFrontSide: on ? 'TOUCH_AKTIV' : 'TOUCH_NICHT_AKTIV', controlIcon: 15 };
            return ctx.signals.set(p, 'ccsControlTouchCCU', v).then(() => { ccu.restore = on; ccu.fails = 0; log.info('touch mode ' + v.controlTouchActiveFrontSide); },
                (e) => { if (!on) ccu.restore = ++ccu.fails < 5; log.warn('touch mode ' + v.controlTouchActiveFrontSide + ': ' + e); });
        }
        // a crash or kill leaves touch mode on until the HMI's next speller or the app's next start (above)
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', safe('shutdown', () => { if (ccu.on || ccu.restore) touchMode(false); carAudio(false); }));

        // GAME on the layer while: its screen up and in front, streaming, the car parked (or parkedOnly off)
        let gameWas = false;
        function sync() {
            const vis = ui.isVisible('GAME') && (!ui.hasFocus || ui.hasFocus('GAME'));
            if (driving() && live()) { stop('car moving'); if (ui.isVisible('GAME')) ui.open('MAIN'); }
            // GAME left (BACK, MENU, another app): the stream ends with it
            if (gameWas && !ui.isVisible('GAME') && live()) stop('left the game screen');
            gameWas = ui.isVisible('GAME');
            const want = vis && st.state === 'streaming' && !driving() && !!gpu.placement;
            let cur = null;
            if (want) { try { const f = fs.statSync(VPATH); cur = f.isFile() ? f.ino : null; } catch (e) { cur = null; } }
            if (want !== shown || cur !== ino) {
                // DROP_VIDEO first: a new frame file (the decoder restarted) is named again
                if (ino !== null && cur !== ino) gpu.video(VID, null);
                if (cur !== null && cur !== ino) gpu.video(VID, VPATH);
                ino = cur;
                if (want !== shown) {
                    shown = want;
                    if (!want) { keys.release(); gpu.video(VID, null); ino = null; }
                    touchMode(want);
                    carAudio(want && settings.get('audio') !== 'off');
                    gpu.grab(want);
                    gpu.show(want);
                    log.info('game layer ' + (want ? 'shown' : 'hidden'));
                }
                if (want) frame();
            }
            if (shown && Date.now() - lastMsg >= KEEPALIVE_MS) frame();
            if (shown && padMode !== 3 && padT > ccu.t + 500 && Date.now() - ccu.t >= 2000) touchMode(true);
            if (!shown && ccu.restore && !ccu.on && Date.now() - ccu.t >= 2000) touchMode(false);   // a refused restore, again
        }
        setInterval(safe('sync', sync), 250);
        setInterval(safe('tailscale', readTs), 5000); safe('tailscale', readTs)();
        if (ui.onFocus) ui.onFocus(safe('focus', () => sync()));
        refresh();
        log.info('moonlight app started');
    },
});
