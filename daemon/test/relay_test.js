'use strict';
// relay.js end to end against a minimal SOCKS5 server (connect + UDP associate) and a fake PC on 127.0.0.2:
//   node test/relay_test.js       (macOS: sudo ifconfig lo0 alias 127.0.0.2 first; Linux has it)
const assert = require('assert');
const net = require('net');
const dgram = require('dgram');
process.env.MGU_SOCKS_PORT = '11055';
const relay = require('../relay');
const PC = '127.0.0.2';

// the fake PC: HTTP port echoes "pc:" + data, UDP 47998 answers "pc:" + datagram
const pcTcp = net.createServer((c) => c.on('data', (d) => c.write('pc:' + d))).listen(47989, PC);
const pcUdp = dgram.createSocket('udp4');
pcUdp.on('message', (m, r) => pcUdp.send(Buffer.concat([Buffer.from('pc:'), m]), r.port, r.address));
pcUdp.bind(47998, PC);

// SOCKS5: no auth; cmd 1 pipes to the target, cmd 3 relays framed datagrams (as tailscaled's net/socks5)
const socks = net.createServer((c) => {
    let stage = 0;
    c.on('data', function f(d) {
        if (stage === 0) { stage = 1; return c.write(Buffer.from([5, 0])); }
        c.removeListener('data', f);
        const ip = Array.from(d.slice(4, 8)).join('.'), port = d.readUInt16BE(8);
        if (d[1] === 1) {
            const t = net.connect(port, ip, () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); t.pipe(c); c.pipe(t); });
            t.on('error', () => c.destroy());
        } else {
            const u = dgram.createSocket('udp4');
            let client = null;
            u.on('message', (m, r) => {
                if (r.address === PC) {
                    const h = Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
                    r.address.split('.').forEach((n, i) => { h[4 + i] = +n; });
                    h.writeUInt16BE(r.port, 8);
                    return u.send(Buffer.concat([h, m]), client.port, client.address);
                }
                client = r;
                u.send(m.slice(10), m.readUInt16BE(8), Array.from(m.slice(4, 8)).join('.'));
            });
            u.bind(0, '127.0.0.1', () => {
                const b = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]);
                b.writeUInt16BE(u.address().port, 8);
                c.write(b);
            });
            c.on('close', () => u.close());
        }
    });
}).listen(11055, '127.0.0.1');

const timeout = setTimeout(() => { console.error('FAIL: timeout'); process.exit(1); }, 5000);
(async () => {
    assert.strictEqual(await relay.direct('127.0.0.3', 300), false, 'nothing there: not direct');
    assert.strictEqual(await relay.direct(PC, 300), true, 'PC answers: direct');
    relay.start(PC);
    await new Promise((r) => setTimeout(r, 100));
    const tcp = await new Promise((resolve) => {
        const c = net.connect(47989, relay.LOCAL, () => c.write('hello'));
        c.on('data', (d) => { resolve(String(d)); c.end(); });
    });
    assert.strictEqual(tcp, 'pc:hello', 'TCP through SOCKS');
    const udp = await new Promise((resolve) => {
        const s = dgram.createSocket('udp4');
        s.on('message', (m) => { resolve(String(m)); s.close(); });
        s.bind(0, '127.0.0.1', () => { s.send('ping1', 47998, relay.LOCAL); setTimeout(() => s.send('ping2', 47998, relay.LOCAL), 50); });
    });
    assert.ok(/^pc:ping[12]$/.test(udp), 'UDP through the association: ' + udp);
    relay.stop();
    assert.strictEqual(relay.target, null);
    clearTimeout(timeout);
    console.log('relay: all checks passed');
    process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
