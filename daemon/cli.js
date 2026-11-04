'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * cli.js - the control plane by hand (Mac/VM tests; on the car moonlightd.js does the same over ctl).
 *
 *   node cli.js HOST DIR info | pair | apps
 *   node cli.js HOST DIR stream APPID [W H FPS KBPS] -- CMD...   launch, run CMD + the stream args, cancel at the end
 *   node cli.js HOST DIR cancel
 * DIR holds key.pem + cert.pem (`mgu-moonlight mkcert DIR`) and server.json (written by pair).
 * stream: CMD is the native binary invocation up to `stream` (for example `docker run -i ... mgu-moonlight`);
 * the app is always quit on the host at the end (Vibepollo's prep commands run on quit, not on disconnect).
 */
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const { GameStream } = require('./gs');

async function main() {
    const [host, dir, cmd, ...rest] = process.argv.slice(2);
    if (!host || !dir || !cmd) throw new Error('usage: node cli.js HOST DIR info|pair|apps|cancel|stream ...');
    const gs = new GameStream({ host, dir });
    if (cmd === 'info') return console.log(await gs.serverinfo());
    if (cmd === 'apps') return console.log(await gs.applist());
    if (cmd === 'cancel') return console.log('cancel:', await gs.cancel());
    if (cmd === 'pair') {
        const info = await gs.serverinfo();
        if (info.paired) return console.log('already paired with', info.hostname);
        const pin = String(crypto.randomInt(10000)).padStart(4, '0');
        console.log('PIN ' + pin + ': type it at https://' + host + ':47990/clients (waits up to MGU_PAIR_TIMEOUT_MS, default 3 min)');
        await gs.pair(pin);
        return console.log('paired with', info.hostname, '-', (await gs.serverinfo()).paired ? 'confirmed' : 'NOT confirmed');
    }
    if (cmd === 'stream') {
        const sep = rest.indexOf('--');
        if (sep < 1) throw new Error('stream APPID [W H FPS KBPS] -- CMD...');
        const [app, w = 1920, h = 720, fps = 60, kbps = 10000] = rest.slice(0, sep).map(Number);
        const bin = rest.slice(sep + 1);
        const launchParams = execFileSync(bin[0], bin.slice(1).concat('launchparams'), { encoding: 'utf8' }).trim();
        const l = await gs.launch({ app, w, h, fps, launchParams });
        console.error('launched:', l.resumed ? 'resumed' : 'new session', l.rtsp, l.info.appversion);
        const args = bin.slice(1).concat(['stream', '--host', host, '--rtsp', l.rtsp || '', '--appver', l.info.appversion,
            '--gfever', l.info.gfeversion, '--codecs', String(l.info.codecs), '--rikey', l.rikey, '--rikeyid', String(l.rikeyid),
            '--w', String(w), '--h', String(h), '--fps', String(fps), '--kbps', String(kbps)], process.env.MGU_ARGS ? process.env.MGU_ARGS.split(' ') : []);
        const child = spawn(bin[0], args, { stdio: ['pipe', 'inherit', 'inherit'] });
        const stop = () => { try { child.stdin.write('stop\n'); } catch (e) { /* gone */ } };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        if (process.env.MGU_SECONDS) setTimeout(stop, +process.env.MGU_SECONDS * 1000);
        const code = await new Promise((r) => child.on('exit', r));
        console.error('stream exited', code, '- quitting the app on the host:', await gs.cancel().catch((e) => e.message));
        return;
    }
    throw new Error('unknown command ' + cmd);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
