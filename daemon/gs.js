'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * gs.js - the GameStream control plane (Sunshine / Vibepollo) in Node 22, built-ins only.
 * The protocol follows moonlight-embedded's libgamestream (client.c) and moonlight-qt's nvpairingmanager.
 *
 *   const gs = new GameStream({ host, dir });   // dir: key.pem + cert.pem (mgu-moonlight mkcert), server.json
 *   await gs.serverinfo()  -> { paired, appversion, gfeversion, codecs, currentgame, state, ... }
 *   await gs.pair(pin)     -> resolves once the PIN was typed on the host (https://HOST:47990/clients)
 *   await gs.applist()     -> [{ id, title }]
 *   await gs.launch({ app, w, h, fps, launchParams }) -> { rtsp, rikey, rikeyid, resumed }
 *   await gs.cancel()      -> quits the running app on the host
 *   await gs.asset(id)     -> { type, buf }: the app's box art (/appasset)
 *
 * Security: after pairing, every HTTPS request trusts exactly the host cert received while pairing
 * (server.json), so /launch's rikey never goes to another machine. The pairing itself checks the
 * host's signature over its secret and its hash of our challenge (moonlight-qt's MITM checks).
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const HTTP_PORT = 47989, HTTPS_PORT = 47984;
const UNIQUE_ID = '0123456789ABCDEF';   // as moonlight-embedded: Sunshine tells clients apart by cert
const PAIR_TIMEOUT_MS = +process.env.MGU_PAIR_TIMEOUT_MS || 180000;   // getservercert waits for the PIN typed on the host
const REQ_TIMEOUT_MS = 15000;
const ASSET_MAX = 8 << 20;              // a box art PNG is ~1 MB

const tag = (xml, t) => { const m = new RegExp('<' + t + '>([^<]*)</' + t + '>').exec(xml); return m ? m[1] : null; };
const uuid = () => crypto.randomUUID();
const hex = (b) => Buffer.from(b).toString('hex').toUpperCase();

/** The signature bytes of an X.509 cert (DER): the BIT STRING that ends the outer SEQUENCE. */
function certSignature(der) {
    const len = (b, i) => {   // -> [length, offset of the content]
        const l = b[i];
        if (l < 0x80) return [l, i + 1];
        const n = l & 0x7f;
        let v = 0;
        for (let k = 0; k < n; k++) v = v * 256 + b[i + 1 + k];
        return [v, i + 1 + n];
    };
    if (der[0] !== 0x30) throw new Error('cert is not a DER SEQUENCE');
    let [, i] = len(der, 1);
    for (let k = 0; k < 2; k++) { const [l, o] = len(der, i + 1); i = o + l; }   // skip tbsCertificate, signatureAlgorithm
    if (der[i] !== 0x03) throw new Error('cert has no signature BIT STRING');
    const [l, o] = len(der, i + 1);
    return der.subarray(o + 1, o + l);   // the first content byte is the count of unused bits (0)
}

function aesEcb(key, data, enc) {
    const c = (enc ? crypto.createCipheriv : crypto.createDecipheriv)('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
}

class GameStream {
    constructor({ host, dir }) {
        this.host = host;
        this.via = null;   // the address requests go to instead of host: relay.js's 127.0.0.1 off the local network
        this.dir = dir;
        this.key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
        this.cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
        this.serverFile = path.join(dir, 'server.json');
        this.server = fs.existsSync(this.serverFile) ? JSON.parse(fs.readFileSync(this.serverFile, 'utf8')) : null;
        if (this.server && this.server.host !== host) this.server = null;   // pinned for another host
        this.info = null;
    }

    _opt(proto, p, query, timeout) {
        const qs = new URLSearchParams(Object.assign({ uniqueid: UNIQUE_ID, uuid: uuid() }, query)).toString();
        const opt = { host: this.via || this.host, port: proto === 'https' ? HTTPS_PORT : HTTP_PORT, path: '/' + p + '?' + qs,
            timeout: timeout || REQ_TIMEOUT_MS, agent: false };   // a fresh socket each time: the host drops kept-alive ones
        if (proto === 'https') {
            if (!this.server) throw new Error('not paired: no pinned host cert');
            Object.assign(opt, { key: this.key, cert: this.cert, ca: this.server.cert, rejectUnauthorized: true,
                checkServerIdentity: () => undefined });   // trust = the pinned cert, not the name
        }
        return opt;
    }

    _get(proto, p, query, timeout) {
        const opt = this._opt(proto, p, query, timeout);
        return new Promise((resolve, reject) => {
            const req = (proto === 'https' ? https : http).get(opt, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (d) => { body += d; if (body.length > 1 << 20) req.destroy(new Error('reply over 1 MiB')); });
                res.on('end', () => {
                    const m = /<root[^>]*status_code="(-?\d+)"(?:[^>]*status_message="([^"]*)")?/.exec(body);
                    if (!m) return reject(new Error(p + ': no <root status_code> (HTTP ' + res.statusCode + ': ' + body.slice(0, 200).replace(/\s+/g, ' ') + ')'));
                    if (m[1] !== '200') return reject(Object.assign(new Error(p + ': ' + m[1] + ' ' + (m[2] || '')), { status: +m[1] }));
                    resolve(body);
                });
            });
            req.on('timeout', () => req.destroy(new Error(p + ': timeout')));
            req.on('error', reject);
        });
    }

    async serverinfo() {
        let xml;
        try { xml = await this._get(this.server ? 'https' : 'http', 'serverinfo', {}); }
        catch (e) { if (!this.server || e.status) throw e; xml = await this._get('http', 'serverinfo', {}); }   // TLS refused: unpaired on the host
        const i = this.info = {
            hostname: tag(xml, 'hostname'), appversion: tag(xml, 'appversion'), gfeversion: tag(xml, 'GfeVersion') || '',
            codecs: +(tag(xml, 'ServerCodecModeSupport') || 0), currentgame: +(tag(xml, 'currentgame') || 0),
            state: tag(xml, 'state'), paired: tag(xml, 'PairStatus') === '1' && !!this.server,
        };
        return i;
    }

    /** Pairs with a 4-digit pin. The first request waits until the pin is typed on the host. */
    async pair(pin) {
        if (!/^\d{4}$/.test(pin)) throw new Error('pin must be 4 digits');
        const info = this.info || await this.serverinfo();
        const major = parseInt(info.appversion, 10);
        const algo = major >= 7 ? 'sha256' : 'sha1', hlen = major >= 7 ? 32 : 20;
        const H = (...b) => crypto.createHash(algo).update(Buffer.concat(b)).digest();
        const step = async (q, to) => {
            const xml = await this._get('http', 'pair', Object.assign({ devicename: 'mgu', updateState: 1 }, q), to);
            if (tag(xml, 'paired') !== '1') throw new Error('host refused the pairing (wrong PIN, or already pairing)');
            return xml;
        };
        try {
            const salt = crypto.randomBytes(16);
            const aes = H(salt, Buffer.from(pin)).subarray(0, 16);
            // the host drops a pending getservercert after ~5 min: ask again with the same salt (same PIN)
            const until = Date.now() + PAIR_TIMEOUT_MS;
            let x1;
            for (;;) {
                try { x1 = await step({ phrase: 'getservercert', salt: hex(salt), clientcert: hex(Buffer.from(this.cert)) }, until - Date.now()); break; }
                catch (e) { if (e.status || Date.now() > until - 5000) throw e; }
            }
            const plain = tag(x1, 'plaincert');
            if (!plain) throw new Error('host sent no cert (a pairing is already in progress on the host?)');
            const serverPem = Buffer.from(plain, 'hex').toString('utf8');
            const serverX = new crypto.X509Certificate(serverPem);

            const challenge = crypto.randomBytes(16);
            const x2 = await step({ clientchallenge: hex(aesEcb(aes, challenge, true)) });
            const resp = aesEcb(aes, Buffer.from(tag(x2, 'challengeresponse') || '', 'hex'), false);
            if (resp.length < hlen + 16) throw new Error('short challenge response');
            const serverHash = resp.subarray(0, hlen), serverChallenge = resp.subarray(hlen, hlen + 16);

            const clientSecret = crypto.randomBytes(16);
            const ourCertSig = certSignature(new crypto.X509Certificate(this.cert).raw);
            const answer = H(serverChallenge, ourCertSig, clientSecret);
            const x3 = await step({ serverchallengeresp: hex(aesEcb(aes, Buffer.concat([answer, Buffer.alloc(32 - answer.length)]), true)) });
            const ps = Buffer.from(tag(x3, 'pairingsecret') || '', 'hex');
            if (ps.length <= 16) throw new Error('short pairing secret');
            const serverSecret = ps.subarray(0, 16), serverSig = ps.subarray(16);
            if (!crypto.verify('sha256', serverSecret, serverX.publicKey, serverSig)) throw new Error('host signature wrong: MITM?');
            if (!H(challenge, certSignature(serverX.raw), serverSecret).equals(serverHash)) throw new Error('host challenge hash wrong (wrong PIN?)');

            const ourSig = crypto.sign('sha256', clientSecret, this.key);   // always SHA-256, as libgamestream's sign_it
            await step({ clientpairingsecret: hex(Buffer.concat([clientSecret, ourSig])) });
            this.server = { host: this.host, cert: serverPem, paired: new Date().toISOString() };
            await this._get('https', 'pair', { devicename: 'mgu', updateState: 1, phrase: 'pairchallenge' });
            const tmp = this.serverFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.server, null, 1), { mode: 0o600 });
            fs.renameSync(tmp, this.serverFile);
            this.info = null;
            return true;
        } catch (e) {
            this.server = this.server && fs.existsSync(this.serverFile) ? JSON.parse(fs.readFileSync(this.serverFile, 'utf8')) : null;
            await this._get('http', 'unpair', {}).catch(() => {});
            throw e;
        }
    }

    async applist() {
        const xml = await this._get('https', 'applist', {});
        const apps = [];
        for (const m of xml.matchAll(/<App>([\s\S]*?)<\/App>/g)) apps.push({ id: +tag(m[1], 'ID'), title: tag(m[1], 'AppTitle') });
        return apps;
    }

    /** An app's box art (the cover Moonlight shows): { type: content-type, buf }. Rejects on an HTTP error. */
    asset(appid) {
        const opt = this._opt('https', 'appasset', { appid, AssetType: 2, AssetIdx: 0 });
        return new Promise((resolve, reject) => {
            const req = https.get(opt, (res) => {
                const parts = [];
                let n = 0;
                res.on('data', (d) => { parts.push(d); n += d.length; if (n > ASSET_MAX) req.destroy(new Error('appasset: over 8 MiB')); });
                res.on('end', () => {
                    if (res.statusCode !== 200) return reject(new Error('appasset ' + appid + ': HTTP ' + res.statusCode));
                    resolve({ type: String(res.headers['content-type'] || ''), buf: Buffer.concat(parts) });
                });
            });
            req.on('timeout', () => req.destroy(new Error('appasset: timeout')));
            req.on('error', reject);
        });
    }

    /** launchParams: `mgu-moonlight launchparams` (common-c's extra query string). */
    async launch({ app, w, h, fps, launchParams }) {
        const info = await this.serverinfo();
        const rikey = crypto.randomBytes(16), rikeyid = crypto.randomBytes(4).readInt32BE(0);
        const resume = info.currentgame !== 0;
        const q = { appid: app, mode: w + 'x' + h + 'x' + fps, additionalStates: 1, sops: 0, rikey: hex(rikey), rikeyid,
            localAudioPlayMode: 0, surroundAudioInfo: 196610 /* stereo, mask 0x3 */, remoteControllersBitmap: 1, gcmap: 1 };
        for (const [k, v] of new URLSearchParams((launchParams || '').replace(/^&/, ''))) q[k] = v;
        // the host's prep commands run first: Game Mode ON waits for the GPU arbiter (up to ~3 min after a quit)
        const xml = await this._get('https', resume ? 'resume' : 'launch', q, 240000);
        if ((tag(xml, 'gamesession') || tag(xml, 'resume')) === '0') throw new Error('host refused to start the app');
        return { rtsp: tag(xml, 'sessionUrl0'), rikey: hex(rikey), rikeyid, resumed: resume, info };
    }

    async cancel() {
        const xml = await this._get('https', 'cancel', {});
        return tag(xml, 'cancel') === '1';
    }
}

module.exports = { GameStream, certSignature };
