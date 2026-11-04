'use strict';
/**
 * input.js - touch and the iDrive controller -> the daemon's input commands.
 *
 * Touch: a point on the 1920 x 720 layer -> the stream's pixels. The renderer fits the video into the
 * layer with its aspect kept and centred (op 19), so 1280 x 720 sits pillarboxed at x 320..1600.
 *
 * Controller (FrontCCU.statusRotaryEncoderState, or the renderer's copy while the app holds it):
 *   turn                  one Down (clockwise) or Up per click
 *   push N / E / S / W    Up / Right / Down / Left, held while pushed
 *   press, short          Enter (sent at release, so a long press can be Esc instead)
 *   press, long           Esc
 *   press, held >= 3 s    then released: Keys' hold() (main.js: the performance overlay on / off; the game got its Esc)
 */
// Windows virtual-key codes, as Moonlight sends them (LiSendKeyboardEvent)
const VK = { ENTER: 13, ESC: 27, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40 };
// FrontCCU enums: the SDK hands them over by name, the renderer as numbers (apps/doom/controls.js has the same tables)
const DEFL = { MITTELSTELLUNG: 0, NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2, NORD_UNWIRKSAM: 3, OST_KURZ_GEDRUECKT: 4,
    OST_LANG_GEDRUECKT: 5, OST_UNWIRKSAM: 6, SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8, SUED_UNWIRKSAM: 9,
    WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11, WEST_UNWIRKSAM: 12, SIGNAL_UNGUELTIG: 15 };
const PUSH = { KEINE_BETAETIGUNG: 0, DREHGEBER_KURZ_GEDRUECKT: 1, DREHGEBER_LANG_GEDRUECKT: 2, UNWIRKSAM: 3, SIGNAL_UNGUELTIG: 15 };
const num = (v, names) => (typeof v === 'number' ? v : v != null && names[v] != null ? names[v] : 15);
const TILT_VK = { 1: VK.UP, 2: VK.UP, 4: VK.RIGHT, 5: VK.RIGHT, 7: VK.DOWN, 8: VK.DOWN, 10: VK.LEFT, 11: VK.LEFT };
const PHASE = { down: 1, move: 2, up: 3 };
const HOLD_MS = 3000, QUIT_MS = 6000;

/** Layer point (x, y) on a W x H layer -> integer pixel of a w x h stream, clamped to it. */
function toStream(x, y, W, H, w, h) {
    const s = Math.min(W / w, H / h), ox = (W - w * s) / 2, oy = (H - h * s) / 2;
    const c = (v, n) => Math.max(0, Math.min(n - 1, Math.round(v)));
    return { x: c((x - ox) / s, w), y: c((y - oy) / s, h) };
}

/*
 * Touchpad (ControllerElements.ZBETouchFrontSide) in touch mode, which the HMI turns on only in its speller
 * (FrontCCU.ccsControlTouchCCU = TOUCH_AKTIV; main.js asks for it while the game shows): statusSystemMode 3,
 * one finger at X1/Y1 (about 0..430 x 0..400, ~50 Hz, each sample twice), X1 = Y1 = 0 lifted. Measured 03/11.
 * Outside touch mode X1/Y1 are no position, so nothing moves. A short still touch is a left click; two of them
 * quickly are a double click (the cursor does not move until a touch went past TAP_MOVE).
 */
// a tap, then the finger down again within DRAG_GAP_MS and moving: the left button held while it moves (a drag)
// a finger held still LONG_MS: a right click
const PAD_MODE = 3, PAD_SCALE = 3, TAP_MS = 220, TAP_MOVE = 12, DRAG_GAP_MS = 300, LONG_MS = 700;   // touchpad units (calibrate on the car)
class Touchpad {
    /** move(dx, dy) stream px; click(button) a press and release; btn(button, down) (drag) */
    constructor(move, click, btn) { Object.assign(this, { move, click, btn: btn || null }); this.last = null; this.down = null; this.rx = 0; this.ry = 0; this.tapT = -1e9; }
    feed(v, now) {
        now = now || Date.now();
        const x = v && v.touchCoordinatesX1FrontSide, y = v && v.touchCoordinatesY1FrontSide;
        if (!v || v.statusSystemModeFrontSide !== PAD_MODE || !(x || y)) {
            const d = this.down;
            if (d && d.drag) this.btn(1, false);
            else if (d && !d.right && now - d.t <= TAP_MS && d.moved <= TAP_MOVE) { this.click(1); this.tapT = now; }
            this.last = null; this.down = null;
            return;
        }
        if (!this.down) this.down = { t: now, moved: 0, afterTap: now - this.tapT <= DRAG_GAP_MS, drag: false, right: false };
        const d = this.down;
        if (!d.right && !d.drag && d.moved <= TAP_MOVE && now - d.t >= LONG_MS) { d.right = true; this.click(3); }
        if (this.last) {
            const dx = x - this.last.x, dy = y - this.last.y;
            d.moved += Math.abs(dx) + Math.abs(dy);
            // still within a tap's wobble: the cursor stays put, so two taps land on one spot = Windows' double click
            if (d.moved <= TAP_MOVE) { this.last = { x, y }; return; }
            if (d.afterTap && !d.drag && !d.right && this.btn) { d.drag = true; this.btn(1, true); }
            this.rx += dx * PAD_SCALE; this.ry -= dy * PAD_SCALE;   // the pad's Y grows upwards, the screen's down
            const mx = Math.trunc(this.rx), my = Math.trunc(this.ry);
            if (mx || my) { this.rx -= mx; this.ry -= my; this.move(mx, my); }
        }
        this.last = { x, y };
    }
}

/*
 * The screen's touch on a remote desktop: a tap = a left click where the finger went down (two taps = a double
 * click: the second lands on the first's point, as Windows wants both within 4 px); a finger that moves past
 * ST_MOVE = the left button pressed where it went down and held while it moves (a title bar, Snap to a side);
 * a finger held still ST_LONG_MS and lifted = a right click. The cursor stays put while the finger only
 * trembles, so a tap clicks where it went down. Points are in stream px.
 * shortcut: one finger only (mgu-render sends the first), so no two-finger scroll; the knob is the wheel -
 * upgrade with a finger count in mgu-render's E_TOUCH.
 */
const ST_MOVE = 18, ST_LONG_MS = 700, ST_TAP2_MS = 400, ST_TAP2_NEAR = 60;
class ScreenTouch {
    /** pos(x, y) the cursor; btn(button, down) */
    constructor(pos, btn) { Object.assign(this, { pos, btn }); this.d = null; this.tap = null; }
    feed(phase, x, y, now) {
        now = now || Date.now();
        const d = this.d;
        if (phase === 'down') {
            const t = this.tap, again = t && now - t.t <= ST_TAP2_MS && Math.abs(x - t.x) + Math.abs(y - t.y) <= ST_TAP2_NEAR;
            this.d = { fx: x, fy: y, x: again ? t.x : x, y: again ? t.y : y, t: now, drag: false };   // f: the finger
            return this.pos(this.d.x, this.d.y);
        }
        if (!d) return;
        if (phase === 'move') {
            if (!d.drag && Math.abs(x - d.fx) + Math.abs(y - d.fy) <= ST_MOVE) return;   // a trembling tap
            if (!d.drag) { d.drag = true; this.btn(1, true); }                         // pressed where it went down
            return this.pos(x, y);
        }
        this.d = null;   // up
        this.tap = null;
        if (d.drag) { this.pos(x, y); this.btn(1, false); return; }
        if (now - d.t >= ST_LONG_MS) { this.btn(3, true); this.btn(3, false); return; }
        this.btn(1, true); this.btn(1, false);
        this.tap = { x: d.x, y: d.y, t: now };
    }
}

class Keys {
    /** key(vk, down): one key event; btn(button, down): a mouse button (1 left, 3 right); hold(): held HOLD_MS; quit(): held QUIT_MS */
    constructor(key, btn, hold, quit, scroll) { Object.assign(this, { key, btn, hold: hold || null, quit: quit || null, scroll: scroll || null }); this.pos = null; this.wheel = false; this.reset(); }
    reset() { this.held = null; this.pressed = false; this.long = false; }
    /** let go of a held direction (leaving the game) and forget the press */
    release() { if (this.held) this.key(this.held, false); if (this.pressed && this.long) this.btn(1, false); this.reset(); }
    tap(vk) { this.key(vk, true); this.key(vk, false); }

    /** One controller state: knob counter, push button, deflection (names or numbers). */
    feed(knob, press, tilt) {
        const pb = num(press, PUSH), df = num(tilt, DEFL);
        if (pb === 15 && df === 15) return;             // no controller behind it (the VM): all SIGNAL_UNGUELTIG
        if (typeof knob === 'number') {
            if (this.pos !== null) {
                const d = ((knob - this.pos + 32768) & 0xffff) - 32768;   // 16-bit counter; a big jump is a reset
                // wheel (the Desktop): one notch per click, clockwise = down; else Down / Up keys
                if (d && Math.abs(d) <= 64 && this.wheel && this.scroll) this.scroll(d > 0 ? -Math.min(d, 10) : Math.min(-d, 10));
                else if (d && Math.abs(d) <= 64) for (let i = 0; i < Math.min(Math.abs(d), 16); i++) this.tap(d > 0 ? VK.DOWN : VK.UP);
            }
            this.pos = knob;
        }
        const vk = TILT_VK[df] || null;
        if (vk !== this.held) {
            if (this.held) this.key(this.held, false);
            if (vk) this.key(vk, true);
            this.held = vk;
        }
        const p = pb === 1 || pb === 2;
        // the push is the mouse's buttons: held = left button down until let go (drag), short = a right click
        // held HOLD_MS and let go: the stats overlay on/off as well (a drag that long is rare)
        if (p && !this.pressed) { this.long = false; this.t0 = Date.now(); }
        if (p && pb === 2 && !this.long) { this.long = true; this.btn(1, true); }
        if (!p && this.pressed) {
            if (this.long) this.btn(1, false); else { this.btn(3, true); this.btn(3, false); }
            const held = this.long ? Date.now() - this.t0 : 0;
            if (held >= QUIT_MS && this.quit) this.quit(); else if (held >= HOLD_MS && this.hold) this.hold();
        }
        this.pressed = p;
    }
}

module.exports = { toStream, Keys, Touchpad, ScreenTouch, VK, PHASE, DEFL, PUSH, HOLD_MS, QUIT_MS };
