/* MEASURE A COLOUR, DON'T GUESS AT IT. The companion to shoot.js: that one
 * lets me see the page, this one lets me ask it what colour something
 * actually came out. Neumorphism lives or dies on a few levels of grey, and
 * reasoning about them from the CSS gets them wrong — SVG filters in
 * particular do their arithmetic in a colour space that is not the one you
 * wrote the numbers in. On /trips the land was measured at #dddddd against a
 * #ececec sea: darker than the water it was supposed to be rising out of,
 * which no amount of squinting at the filter would have told me.
 *
 *   node scripts/shoot.js <url> shot.png
 *   node scripts/pixel.js shot.png 700,560 200,470      one pixel each
 *   node scripts/pixel.js shot.png --hist 300,90,700,240   commonest in a box
 *
 * Handles 8-bit non-interlaced PNGs, which is what headless Chrome writes.
 */
const fs = require('fs'), zlib = require('zlib');

function decode(file) {
    const buf = fs.readFileSync(file);
    let p = 8, w = 0, h = 0, depth = 0, ctype = 0;
    const idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
        const data = buf.subarray(p + 8, p + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            depth = data[8]; ctype = data[9];
            if (data[12] !== 0) throw new Error('interlaced PNG not handled');
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        p += 12 + len;
    }
    if (depth !== 8) throw new Error('bit depth ' + depth + ' not handled');
    const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
    if (!ch) throw new Error('colour type ' + ctype + ' not handled');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch, out = Buffer.alloc(h * stride);
    let q = 0;
    for (let y = 0; y < h; y++) {
        const f = raw[q++];
        const row = raw.subarray(q, q + stride); q += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
        for (let i = 0; i < stride; i++) {
            const a = i >= ch ? cur[i - ch] : 0;
            const b = prev ? prev[i] : 0;
            const c = (prev && i >= ch) ? prev[i - ch] : 0;
            let v = row[i];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) {
                const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            cur[i] = v & 255;
        }
    }
    return { w, h, ch, px: out };
}

const argv = process.argv.slice(2);
const hi = argv.indexOf('--hist');
const file = argv[0];
const spots = (hi === -1 ? argv.slice(1) : argv.slice(1, hi));
const img = decode(file);
console.log(`${img.w}x${img.h}, ${img.ch} channels`);
for (const s of spots) {
    const [x, y] = s.split(',').map(Number);
    const i = (y * img.w + x) * img.ch;
    const [r, g, b] = [img.px[i], img.px[i + 1], img.px[i + 2]];
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    console.log(`  ${s.padEnd(10)} ${hex}  rgb(${r},${g},${b})`);
}

/* --hist x0,y0,x1,y1 — the commonest colours in a box, for when you know
   roughly where a thing is but not its exact pixel. */
if (process.argv.includes('--hist')) {
    const box = process.argv[process.argv.indexOf('--hist') + 1].split(',').map(Number);
    const [x0, y0, x1, y1] = box;
    const tally = new Map();
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * img.w + x) * img.ch;
        const k = (img.px[i] << 16) | (img.px[i + 1] << 8) | img.px[i + 2];
        tally.set(k, (tally.get(k) || 0) + 1);
    }
    const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const n = (x1 - x0) * (y1 - y0);
    console.log(`  commonest in ${box.join(',')}:`);
    for (const [k, c] of top)
        console.log(`    #${k.toString(16).padStart(6, '0')}  ${(c / n * 100).toFixed(1)}%`);
}
