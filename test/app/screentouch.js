// ScreenTouch (input.js) on touches recorded in a car: node test/app/screentouch.js
const assert = require('assert'); const { ScreenTouch } = require('../../apps/jap_moonride/input');
const ev = []; const s = new ScreenTouch((x, y) => ev.push(['pos', x, y]), (b, d) => ev.push([b, d]));
const btns = () => ev.filter((e) => e[0] !== 'pos'), poss = () => ev.filter((e) => e[0] === 'pos').map((e) => [e[1], e[2]]);
// a recorded double tap: both clicks on one point, jitter ignored
s.feed('down', 947, 518, 1000); s.feed('move', 951, 521, 1040); s.feed('up', 951, 521, 1080);
s.feed('down', 960, 506, 1220); s.feed('move', 958, 509, 1260); s.feed('up', 958, 509, 1300);
assert.deepStrictEqual(poss(), [[947, 518], [947, 518]], 'both clicks at 947,518');
assert.deepStrictEqual(btns(), [[1, true], [1, false], [1, true], [1, false]]);
ev.length = 0; s.feed('down', 100, 100, 5000); s.feed('move', 160, 100, 6000); s.feed('up', 1900, 300, 6500);   // slow start, then a drag
assert.deepStrictEqual(btns(), [[1, true], [1, false]], 'held then moved: a drag, no right click');
assert.deepStrictEqual(poss()[0], [100, 100], 'pressed where it went down');
ev.length = 0; s.feed('down', 50, 50, 9000); s.feed('up', 52, 50, 9800);
assert.deepStrictEqual(btns(), [[3, true], [3, false]], 'held still: right click');
console.log('screentouch ok');
