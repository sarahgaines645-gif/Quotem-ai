/**
 * q-qr.js — QR code builder for Q.
 *
 * Q's counterpart to Quotem's wa-share.js: turns a string into a scannable
 * QR PNG. Two flavours, both generated server-side so Q can hand one back
 * inside a chat reply:
 *   · CALL / DIAL — a `tel:` QR that rings the number when a phone camera
 *     scans it (the same thing the Tasks drawer's "Schedule Call" modal
 *     draws client-side).
 *   · WHATSAPP — a `wa.me` QR that opens a WhatsApp chat with the message
 *     already typed. Same deep-link wa-share.js uses in Quotem.
 *
 * No new npm dependency:
 *   · qrcode-generator (Kazuhiko Arase) is already vendored at repo root as
 *     qrcode.min.js for the browser; it exports through module.exports too,
 *     so Node can require the exact same file the page uses.
 *   · sharp (already a dependency) turns the module matrix into a PNG from a
 *     raw 1-byte-per-pixel buffer — no SVG rasteriser, no GIF decoding.
 *
 * Public surface:
 *   buildQrPng(text, opts?)          → Promise<Buffer>  (PNG bytes)
 *   buildCallQr({ phone, name })     → { ok, telUri, number, png, caption }
 *   buildWhatsappQr({ phone, message, name })
 *                                    → { ok, url, number, message, png, caption }
 */
'use strict';

const path = require('path');
const sharp = require('sharp');
const qrcode = require(path.join(__dirname, '..', 'qrcode.min.js'));

/**
 * Render any string as a QR PNG.
 *
 * @param {string} text   what the QR encodes (a tel: URI, a URL, anything)
 * @param {object} [opts]
 * @param {number} [opts.size=360]    output width/height in px
 * @param {number} [opts.margin=4]    quiet-zone width in MODULES (the spec's
 *                                    minimum is 4 — scanners need it)
 * @param {string} [opts.ec='M']      error correction: L | M | Q | H
 */
async function buildQrPng(text, { size = 360, margin = 4, ec = 'M' } = {}) {
    const data = String(text || '');
    if (!data) throw new Error('buildQrPng: nothing to encode');

    // typeNumber 0 = auto-fit the smallest QR version that holds the data.
    const qr = qrcode(0, ec);
    qr.addData(data);
    qr.make();

    const count = qr.getModuleCount();
    const dim = count + margin * 2;

    // Greyscale raw buffer: 255 = white paper, 0 = black module.
    const raw = Buffer.alloc(dim * dim, 255);
    for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
            if (qr.isDark(r, c)) raw[(r + margin) * dim + (c + margin)] = 0;
        }
    }

    // 'nearest' keeps the modules as hard-edged squares — a smooth kernel
    // blurs the edges and some phone cameras then fail to lock on.
    return sharp(raw, { raw: { width: dim, height: dim, channels: 1 } })
        .resize(size, size, { kernel: 'nearest' })
        .png()
        .toBuffer();
}

/**
 * Build a CALL / DIAL QR. Scanning it offers to ring the number — it is a
 * `tel:` QR, not a WhatsApp one.
 *
 * @param {object} args
 * @param {string} args.phone  the number to dial
 * @param {string} [args.name] who it belongs to, for the caption
 */
async function buildCallQr({ phone, name } = {}) {
    // Keep digits and a leading +; strip spaces, brackets, dashes.
    const number = String(phone || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
    if (!number || number.replace(/\D/g, '').length < 5) {
        return { ok: false, error: 'No usable phone number provided' };
    }
    const telUri = `tel:${number}`;
    try {
        const png = await buildQrPng(telUri);
        return {
            ok: true,
            telUri,
            number,
            png,
            caption: `Scan to dial ${name ? name + ' — ' : ''}${number}`,
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Build a WHATSAPP QR. Scanning it opens a WhatsApp chat — with that number
 * if one is given, otherwise WhatsApp's own contact picker — with `message`
 * already typed into the box, waiting for the person to hit send.
 *
 * wa.me carries TEXT ONLY. WhatsApp's deep link cannot attach a photo, a PDF
 * or any file; whoever scans it sends attachments from inside WhatsApp. Say
 * so rather than implying a quote or a document can ride along.
 *
 * @param {object} args
 * @param {string} [args.phone]    number to open the chat with. Omit for a
 *                                 "message is ready, pick who gets it" link.
 * @param {string} [args.message]  text pre-filled into the message box
 * @param {string} [args.name]     who the number belongs to, for the caption
 */
async function buildWhatsappQr({ phone, message, name } = {}) {
    // wa.me takes digits only — no '+', no spaces, no brackets, no dashes.
    const number = String(phone || '').replace(/\D/g, '');
    if (phone && number.length < 5) {
        return { ok: false, error: 'No usable phone number provided' };
    }
    const text = String(message || '').trim();
    if (!number && !text) {
        return { ok: false, error: 'Needs a number to message, some text to pre-fill, or both' };
    }

    const url = `https://wa.me/${number}${text ? '?text=' + encodeURIComponent(text) : ''}`;
    try {
        const png = await buildQrPng(url);
        return {
            ok: true,
            url,
            number: number || null,
            message: text || null,
            png,
            caption: number
                ? `Scan to WhatsApp ${name ? name + ' — ' : ''}+${number}`
                : 'Scan to open WhatsApp with the message ready',
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = { buildQrPng, buildCallQr, buildWhatsappQr };
