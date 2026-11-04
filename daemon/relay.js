// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
'use strict';
/**
 * relay.js - the PC through Tailscale when it is not on the car's network (5G): the car's tailscaled runs in userspace
 * networking, so nothing routes to the tailnet; its SOCKS5 server (127.0.0.1:MGU_SOCKS_PORT, UDP ASSOCIATE included,
 * the jap-tailscale tool, port MGU_SOCKS_PORT) does. While on, Moonlight's ports listen on 127.0.0.1 and go through it to the
 * PC (on the tailnet, or behind a subnet router), so the daemon and the stream binary just talk to 127.0.0.1.
 *
 *   const r = require('./relay'); await r.direct(ip) -> true when the PC answers without it
 *   r.start(ip); r.stop(); r.target -> the PC relayed to, or null
 */
const net = require('net');
const dgram = require('dgram');

const SOCKS_PORT = +process.env.MGU_SOCKS_PORT || 1065, SOCKS_HOST = '127.0.0.1';
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

/** One SOCKS5 request (cmd 1 connect, 3 UDP associate) -> { sock, port (bound), rest (bytes after the reply) }. */
function socks(cmd, ip, port) {
    return new Promise((resolve, reject) => {
        const s = net.connect(SOCKS_PORT, SOCKS_HOST);
        let stage = 0, buf = Buffer.alloc(0);
        const fail = (e) => { s.destroy(); reject(e instanceof Error ? e : new Error('socks: ' + e)); };
        s.setTimeout(5000, () => fail('timeout'));
        s.on('error', fail);
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
            resolve({ sock: s, port: buf.readUInt16BE(3 + n - 2), rest: buf.slice(3 + n) });
        });
    });
}

let servers = [], target = null;

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
    let peer = null, up = null, ctl = null, relayPort = 0, pending = [];
    const hdr = Buffer.concat([Buffer.from([0, 0, 0, 1]), addr(target, p)]);
    const reset = () => { if (ctl) ctl.destroy(); if (up) up.close(); ctl = up = null; relayPort = 0; pending = []; };
    function associate() {
        const u = up = dgram.createSocket('udp4');
        u.bind(0, LOCAL, () => socks(3, '0.0.0.0', 0).then((r) => {
            if (up !== u) return r.sock.destroy();
            ctl = r.sock; relayPort = r.port;
            ctl.on('error', reset); ctl.on('close', () => { if (up === u) reset(); });
            for (const m of pending.splice(0)) u.send(m, relayPort, LOCAL);
        }, (e) => { console.log('relay udp ' + p + ':', e.message); if (up === u) reset(); }));
        u.on('message', (m) => {   // from the PC: strip the SOCKS header
            const n = addrLen(m, 3);
            if (n > 0 && peer) local.send(m.slice(3 + n), peer.port, peer.address);
        });
        u.on('error', () => { if (up === u) reset(); });
    }
    local.on('message', (m, rinfo) => {
        peer = rinfo;
        const f = Buffer.concat([hdr, m]);
        if (!up) associate();
        if (relayPort) up.send(f, relayPort, LOCAL); else if (pending.length < 64) pending.push(f);
    });
    local.on('error', (e) => console.log('relay udp ' + p + ':', e.message));
    local.bind(p, LOCAL);
    return { close: () => { reset(); local.close(); } };
}

/** Relay to the PC at ip (idempotent; another ip restarts it). */
function start(ip) {
    if (target === ip) return;
    stop();
    target = ip;
    servers = TCP.map(tcpPort).concat(UDP.map(udpPort));
    console.log('relay: ' + ip + ' through Tailscale (SOCKS5 ' + SOCKS_HOST + ':' + SOCKS_PORT + ')');
}
function stop() {
    for (const s of servers) try { s.close(); } catch (e) { /* closed */ }
    servers = []; target = null;
}

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

module.exports = { start, stop, direct, get target() { return target; }, LOCAL, _socks: socks, _addrLen: addrLen };
