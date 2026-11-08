'use strict';
// relay.js end to end against minimal SOCKS5 servers (connect + UDP associate) and a fake PC on 127.0.0.3:
//   node test/relay_test.js       (needs 127.0.0.2-4: Linux has them; macOS: sudo ifconfig lo0 alias 127.0.0.x)
const assert = require('assert');
const net = require('net');
const dgram = require('dgram');
process.env.MGU_SOCKS = '127.0.0.1:11065 127.0.0.2:11055';   // jap-wireproxy's place, then Tailscale's
const relay = require('../relay');
const PC = '127.0.0.3';

// the fake PC: HTTP port echoes "pc:" + data, UDP 47998 answers "pc:" + datagram
net.createServer((c) => c.on('data', (d) => c.write('pc:' + d))).listen(47989, PC);
const pcUdp = dgram.createSocket('udp4');
pcUdp.on('message', (m, r) => pcUdp.send(Buffer.concat([Buffer.from('pc:'), m]), r.port, r.address));
pcUdp.bind(47998, PC);

// SOCKS5 on host:port, no auth: cmd 1 pipes to the target (reply 5 when it refuses), cmd 3 relays framed datagrams
// on a UDP socket on host, from the control connection's address only, and answers BND.ADDR bnd (0.0.0.0: the client
// uses the proxy's host)
function socksServer(host, port, bnd) {
    const n = { connect: 0, udp: 0 };
    net.createServer((c) => {
        let stage = 0;
        c.on('error', () => {});
        c.on('data', function f(d) {
            if (stage === 0) { stage = 1; return c.write(Buffer.from([5, 0])); }
            c.removeListener('data', f);
            const ip = Array.from(d.slice(4, 8)).join('.'), p = d.readUInt16BE(8);
            if (d[1] === 1) {
                n.connect++;
                const t = net.connect(p, ip, () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); t.pipe(c); c.pipe(t); });
                t.on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
            } else {
                const u = dgram.createSocket('udp4');
                let client = null;
                u.on('message', (m, r) => {
                    if (r.address === PC) {
                        const h = Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
                        r.address.split('.').forEach((x, i) => { h[4 + i] = +x; });
                        h.writeUInt16BE(r.port, 8);
                        return u.send(Buffer.concat([h, m]), client.port, client.address);
                    }
                    if (r.address !== c.remoteAddress) return;      // not the association's client
                    client = r; n.udp++;
                    u.send(m.slice(10), m.readUInt16BE(8), Array.from(m.slice(4, 8)).join('.'));
                });
                u.bind(0, host, () => {
                    const b = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
                    bnd.split('.').forEach((x, i) => { b[4 + i] = +x; });
                    b.writeUInt16BE(u.address().port, 8);
                    c.write(b);
                });
                c.on('close', () => u.close());
            }
        });
    }).listen(port, host);
    return n;
}

const tcpThrough = () => new Promise((resolve) => {
    const c = net.connect(47989, relay.LOCAL, () => c.write('hello'));
    c.on('data', (d) => { resolve(String(d)); c.end(); });
});
const udpThrough = () => new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('message', (m) => { resolve(String(m)); s.close(); });
    s.bind(0, '127.0.0.1', () => { s.send('ping1', 47998, relay.LOCAL); setTimeout(() => s.send('ping2', 47998, relay.LOCAL), 50); });
});

const timeout = setTimeout(() => { console.error('FAIL: timeout'); process.exit(1); }, 10000);
(async () => {
    assert.strictEqual(await relay.direct('127.0.0.4', 300), false, 'nothing there: not direct');
    assert.strictEqual(await relay.direct(PC, 300), true, 'PC answers: direct');

    // nothing on the first way (refused): the second one, Tailscale's, with BND.ADDR 0.0.0.0
    const ts = socksServer('127.0.0.2', 11055, '0.0.0.0');
    await relay.start(PC);
    assert.strictEqual(relay.way.name, 'Tailscale', 'first way refused: the second');
    assert.strictEqual(await tcpThrough(), 'pc:hello', 'TCP through the second way');
    assert.ok(/^pc:ping[12]$/.test(await udpThrough()), 'UDP through the second way');
    assert.ok(ts.udp > 0, 'datagrams through its association');
    relay.stop();
    assert.strictEqual(relay.target, null);

    // both up: the first one, jap-wireproxy's, with its own BND.ADDR
    const wg = socksServer('127.0.0.1', 11065, '127.0.0.1');
    const before = ts.connect;
    await relay.start(PC);
    assert.strictEqual(relay.way.name, 'jap-wireproxy', 'first way answers: the first');
    assert.strictEqual(await tcpThrough(), 'pc:hello', 'TCP through the first way');
    assert.ok(/^pc:ping[12]$/.test(await udpThrough()), 'UDP through the first way');
    assert.ok(wg.udp > 0 && ts.connect === before, 'nothing through the second way');

    // the same PC again keeps the way; a PC no way reaches still gets the ports, through the first way
    await Promise.all([relay.start(PC), relay.start(PC)]);
    assert.strictEqual(relay.way.name, 'jap-wireproxy');
    await relay.start('127.0.0.4');
    assert.strictEqual(relay.target, '127.0.0.4', 'no way answers: relayed anyway');
    assert.strictEqual(relay.way.name, 'jap-wireproxy');
    relay.stop();
    clearTimeout(timeout);
    console.log('relay: all checks passed');
    process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
