/* Build the flat map's shapes for /trips from Natural Earth 50m.
 *
 *   curl -o land50.json      https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json
 *   curl -o countries50.json https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json
 *   node scripts/build-map-shapes.js            (run from the folder holding those two)
 *
 *
 * The page draws an equirectangular world 2000 units wide, cropped to the
 * latitudes anyone actually flies to (80N to 56S) so the empty polar bands do
 * not eat the frame. The land is ONE path: with fill-rule nonzero the country
 * polygons merge into a single silhouette, which is what the relief filter
 * needs — it lights the coast, not every internal border.
 *
 * The previous file was 110m data. At the zoom a 4-hour search settles on it
 * went visibly polygonal, which is the whole reason for this rebuild.
 */
const fs = require('fs');
const path = require('path');

const W = 2000, LAT_TOP = 80, LAT_BOT = -56;
const H = Math.round(W * (LAT_TOP - LAT_BOT) / 360);       // 756 at W=2000

const project = (lon, lat) => [
    (lon + 180) / 360 * W,
    (LAT_TOP - lat) / (LAT_TOP - LAT_BOT) * H,
];

/* --- topojson, decoded here rather than pulling in a dependency --- */
function arcPoints(topo, i) {
    const rev = i < 0;
    const arc = topo.arcs[rev ? ~i : i];
    const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
    let x = 0, y = 0;
    const out = arc.map(([dx, dy]) => {
        x += dx; y += dy;
        return [x * sx + tx, y * sy + ty];
    });
    return rev ? out.reverse() : out;
}
function ringToPath(topo, arcIdx) {
    let pts = [];
    for (const i of arcIdx) {
        const p = arcPoints(topo, i);
        pts = pts.length ? pts.concat(p.slice(1)) : p;
    }
    return pts;
}


/* THE BAR ACROSS THE TOP OF THE MAP.
   Eurasia is one ring that runs off the east edge at the dateline and comes
   back on at the west, so its two ends were joined by a single segment 2000
   units long: a filled band straight across the Arctic. Cut the ring at the
   antimeridian in lon/lat, before projecting, and close each half against the
   edge it left by. */
function splitAtDateline(pts) {
    const out = [];
    let cur = [];
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (i > 0) {
            const q = pts[i - 1];
            const d = p[0] - q[0];
            if (Math.abs(d) > 180) {
                const sign = d > 0 ? -1 : 1;              // the edge we leave by
                const dl = d > 0 ? d - 360 : d + 360;     // the short way round
                const t = (sign * 180 - q[0]) / dl;
                const lat = q[1] + t * (p[1] - q[1]);
                cur.push([sign * 180, lat]);
                out.push(cur);
                cur = [[-sign * 180, lat]];
            }
        }
        cur.push(p);
    }
    if (cur.length) out.push(cur);
    /* The ring started mid-chunk, so its first and last pieces are one piece. */
    if (out.length > 1) { out[0] = out.pop().concat(out[0]); }
    return out;
}
/* Douglas–Peucker, in projected units, so the tolerance means the same thing
   everywhere on the map. 0.35 units ≈ a third of a pixel at world scale. */
function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const sq = tol * tol;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let best = -1, bestD = 0;
        const [ax, ay] = pts[a], [bx, by] = pts[b];
        const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
        for (let i = a + 1; i < b; i++) {
            const [px, py] = pts[i];
            let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = ax + t * dx - px, ey = ay + t * dy - py;
            const d = ex * ex + ey * ey;
            if (d > bestD) { bestD = d; best = i; }
        }
        if (bestD > sq && best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    return pts.filter((_, i) => keep[i]);
}

const n = v => {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

function ringsToD(topo, polys, tol, minArea) {
    const parts = [];
    for (const poly of polys) {
        for (const ring of poly) {
          for (const piece of splitAtDateline(ringToPath(topo, ring))) {
            let pts = piece.map(([lon, lat]) => project(lon, lat));
            /* Anything entirely off the cropped band is dead weight. */
            if (pts.every(p => p[1] < -20) || pts.every(p => p[1] > H + 20)) continue;
            pts = simplify(pts, tol);
            if (pts.length < 4) continue;
            /* Shoelace: drop specks smaller than a pixel or two. */
            let a2 = 0;
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
                a2 += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
            if (Math.abs(a2 / 2) < minArea) continue;
            parts.push('M' + pts.map(p => n(p[0]) + ' ' + n(p[1])).join('L') + 'Z');
          }
        }
    }
    return parts.join('');
}

const land = JSON.parse(fs.readFileSync('land50.json', 'utf8'));
const geo = land.objects.land.geometries;
const polys = [];
for (const g of geo) {
    if (g.type === 'Polygon') polys.push(g.arcs);
    else if (g.type === 'MultiPolygon') for (const p of g.arcs) polys.push(p);
}
const landD = ringsToD(land, polys, 0.35, 1.2);

/* Country lines, kept separate so the page can decide whether to draw them. */
const ctry = JSON.parse(fs.readFileSync('countries50.json', 'utf8'));
const cgeo = ctry.objects.countries.geometries;
const cpolys = [];
for (const g of cgeo) {
    if (g.type === 'Polygon') cpolys.push(g.arcs);
    else if (g.type === 'MultiPolygon') for (const p of g.arcs) cpolys.push(p);
}
const bordersD = ringsToD(ctry, cpolys, 0.6, 6);

/* The page draws the LAND ONLY. Country lines are a printed-atlas idea and
   they fight the raised surface — the relief is the map. They are built here
   anyway, and kept out of the file, so bringing them back is a one-line
   change rather than a rebuild. */
const out = { W, H, LAT_TOP, LAT_BOT, land: landD };
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'map-countries.json'), JSON.stringify(out));
console.log('W', W, 'H', H);
console.log('land   ', landD.length, 'chars,', (landD.match(/M/g) || []).length, 'rings');
console.log('borders', bordersD.length, 'chars,', (bordersD.match(/M/g) || []).length, 'rings');
console.log('written to assets/map-countries.json');
