'use strict';

/**
 * Generate PNG favicon assets from favicon.svg.
 *
 * Outputs:
 *   - favicon-180.png  → iOS apple-touch-icon
 *   - favicon-192.png  → Android home-screen (manifest)
 *   - favicon-512.png  → Android splash / large home-screen
 *
 * Run once after editing the SVG: `node scripts/generate-favicon-png.js`
 * Commit the PNGs alongside the SVG. Sharp renders text using system fonts,
 * so the rendered Q character may differ slightly from the design SVG —
 * that's fine for icon purposes (any sans-serif Q is recognisable; the
 * pink dot is the distinctive mark).
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svgPath = path.join(ROOT, 'favicon.svg');

const sizes = [180, 192, 512];

(async () => {
    if (!fs.existsSync(svgPath)) {
        console.error('favicon.svg not found at', svgPath);
        process.exit(1);
    }
    const svg = fs.readFileSync(svgPath);
    for (const size of sizes) {
        const out = path.join(ROOT, `favicon-${size}.png`);
        await sharp(svg, { density: 300 })
            .resize(size, size, { fit: 'contain', background: { r: 232, g: 232, b: 232, alpha: 1 } })
            .png()
            .toFile(out);
        console.log(`✓ ${path.basename(out)} (${size}×${size})`);
    }
    console.log('Done.');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
