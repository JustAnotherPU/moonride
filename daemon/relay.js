// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
'use strict';
/**
 * relay.js - the PC when it is not on the car's network (5G), through a tunnel's SOCKS5 server (CONNECT and UDP
 * ASSOCIATE): nothing on the head unit routes to the tunnels, their SOCKS5 servers do. MGU_SOCKS lists the ways in
 * order, "host:port host:port"; by default jap-wireproxy (127.0.0.1:1065, your WireGuard server) then IterioDev's
 * Tailscale (iteriodev-tailscale, 127.0.0.2:1055 once its SOCKS5 is enabled). The first way that reaches the PC is used.
 * While on, Moonlight's ports listen on 127.0.0.1 and go through it to the PC, so the daemon and the stream binary
 * just talk to 127.0.0.1.
 *
 *   const r = require('./relay'); await r.direct(ip) -> true when the PC answers without it
 *   await r.start(ip); r.stop(); r.target -> the PC relayed to, or null; r.way -> { host, port, name }, or null
 */
const net = require('net');
const dgram = require('dgram');

// a way's name is only for the log: iteriodev-tailscale is the one on 127.0.0.2
const WAYS = (process.env.MGU_SOCKS || '127.0.0.1:1065 127.0.0.2:1055').trim().split(/\s+/).map((w) => {
    const [host, port] = w.split(':');
    return { host, port: +port, name: host === '127.0.0.2' ? 'Tailscale' : 'jap-wireproxy' };
});
const LOCAL = '127.0.0.1';
const TCP = [47984, 47989, 48010];          // HTTPS, HTTP, RTSP
const UDP = [47998, 47999, 48000];          // video, control (ENet), audio

/** SOCKS5 address block for an IPv4 target. */
function addr(ip, port) {
    const b = Buffer.alloc(6);
    ip.split('.').forEach((n, i) => { b[i] = +n; });
    b.writeUInt16BE(port, 4);
    return b;
}
/** Length of a SOCKS5 address block (atyp byte included) at buf[i], or -1 when incomplete. */
function addrLen(buf, i) {
    if (buf.length <= i) return -1;
    const t = buf[i], n = t === 1 ? 7 : t === 4 ? 19 : t === 3 && buf.length > i + 1 ? 4 + buf[i + 1] : -1;
    return n > 0 && buf.length >= i + n ? n : -1;
}

/** One SOCKS5 request (cmd 1 connect, 3 UDP associate) through way w (default: the relay's)
 *  -> { sock, host + port (bound; host null unless IPv4), rest (bytes after the reply) }. */
function socks(cmd, ip, port, w) {
    w = w || way;
    return new Promise((resolve, reject) => {
        const s = net.connect(w.port, w.host);
        let stage = 0, buf = Buffer.alloc(0);
        const fail = (e) => { s.destroy(); reject(e instanceof Error ? e : new Error('socks: ' + e)); };
        s.setTimeout(5000, () => fail('timeout'));
        s.on('error', fail);
        s.on('close', () => fail('closed before its reply'));   // (after the reply: a no-op)
        s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
        s.on('data', function onData(d) {
            buf = Buffer.concat([buf, d]);
            if (stage === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 5 || buf[1] !== 0) return fail('auth refused');
                buf = buf.slice(2); stage = 1;
                s.write(Buffer.concat([Buffer.from([5, cmd, 0, 1]), addr(ip, port)]));
            }
            if (buf.length < 4) return;
            if (buf[1] !== 0) return fail('reply ' + buf[1]);
            const n = addrLen(buf, 3);
            if (n < 0) return;
            s.removeListener('data', onData);
            s.setTimeout(0);
            resolve({ sock: s, host: buf[3] === 1 ? Array.from(buf.slice(4, 8)).join('.') : null,
                port: buf.readUInt16BE(3 + n - 2), rest: buf.slice(3 + n) });
        });
    });
}

let servers = [], target = null, way = null, sure = false, picking = null, gen = 0;

function tcpPort(p) {
    const srv = net.createServer((c) => {
        c.pause();
        socks(1, target, p).then(({ sock, rest }) => {
            if (rest.length) c.write(rest);
            sock.pipe(c); c.pipe(sock); c.resume();
            const end = () => { c.destroy(); sock.destroy(); };
            c.on('error', end); sock.on('error', end); c.on('close', end); sock.on('close', end);
        }, () => c.destroy());
    });
    srv.on('error', (e) => console.log('relay tcp ' + p + ':', e.message));
    srv.listen(p, LOCAL);
    return srv;
}

/** A UDP port: the stream binary's datagrams on 127.0.0.1:p <-> the PC's p, framed through one UDP association. */
function udpPort(p) {
    const local = dgram.createSocket('udp4');
    let peer = null, up = null, ctl = null, to = null, pending = [];
    const hdr = Buffer.concat([Buffer.from([0, 0, 0, 1]), addr(target, p)]);
    const reset = () => { if (ctl) ctl.destroy(); if (up) up.close(); ctl = up = to = null; pending = []; };
    function associate() {
        const u = up = dgram.createSocket('udp4'), w = way;
        u.on('message', (m) => {   // from the PC: strip the SOCKS header
            const n = addrLen(m, 3);
            if (n > 0 && peer) local.send(m.slice(3 + n), peer.port, peer.address);
        });
        u.on('error', () => { if (up === u) reset(); });
        socks(3, '0.0.0.0', 0, w).then((r) => {
            if (up !== u) return r.sock.destroy();
            ctl = r.sock;
            ctl.on('error', reset); ctl.on('close', () => { if (up === u) reset(); });
            // the datagrams come from the control connection's address and go to BND.ADDR (0.0.0.0: the proxy's host)
            u.bind(0, ctl.localAddress, () => {
                if (up !== u) return;
                to = { host: r.host && r.host !== '0.0.0.0' ? r.host : w.host, port: r.port };
                for (const m of pending.splice(0)) u.send(m, to.port, to.host);
            });
        }, (e) => { console.log('relay udp ' + p + ':', e.message); if (up === u) reset(); });
    }
    local.on('message', (m, rinfo) => {
        peer = rinfo;
        const f = Buffer.concat([hdr, m]);
        if (!up) associate();
        if (to) up.send(f, to.port, to.host); else if (pending.length < 64) pending.push(f);
    });
    local.on('error', (e) => console.log('relay udp ' + p + ':', e.message));
    local.bind(p, LOCAL);
    return { close: () => { reset(); local.close(); } };
}

/** True when the PC's HTTP port answers through way w. */
const works = (w, ip) => socks(1, ip, 47989, w).then((r) => { r.sock.destroy(); return true; }, () => false);

/** Relay to the PC at ip through the first way that reaches it; resolves once the ports listen. The same ip again
 *  keeps a way that answered once, without probing it again (a probe failing mid-game would move a live stream);
 *  when no way answered, the ports go through the first one, as without a probe, and the next start tries them all again. */
function start(ip) {
    if (picking && picking.ip === ip) return picking;
    const g = ++gen;
    const p = (async () => {
        if (target === ip && sure) return;
        let w = null;
        for (const x of WAYS) if (await works(x, ip)) { w = x; break; }
        if (g !== gen) return;      // stopped, or another PC, meanwhile
        if (!w) console.log('relay: ' + ip + ' answers through none of ' + WAYS.map((x) => x.host + ':' + x.port).join(', ') + ', trying again on the next start');
        if (target === ip && (!w || w === way)) { sure = !!w; return; }
        close();
        target = ip; way = w || WAYS[0]; sure = !!w;
        servers = TCP.map(tcpPort).concat(UDP.map(udpPort));
        if (w) console.log('relay: ' + ip + ' through ' + w.name + ' (SOCKS5 ' + w.host + ':' + w.port + ')');
    })().finally(() => { if (g === gen) picking = null; });
    p.ip = ip;
    return (picking = p);
}
function close() {
    for (const s of servers) try { s.close(); } catch (e) { /* closed */ }
    servers = []; target = way = null; sure = false;
}
function stop() { gen++; picking = null; close(); }

/** True when the PC's HTTP port answers directly within ms (same network), false otherwise (5G). */
function direct(ip, ms) {
    return new Promise((resolve) => {
        const s = net.connect(47989, ip);
        const done = (ok) => { s.destroy(); resolve(ok); };
        s.setTimeout(ms || 1500, () => done(false));
        s.on('connect', () => done(true));
        s.on('error', () => done(false));
    });
}

module.exports = { start, stop, direct, get target() { return target; }, get way() { return way; }, LOCAL, _socks: socks, _addrLen: addrLen };
