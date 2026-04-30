/**
 * mailer.js — single source of truth for sending email from quotem-ai.
 *
 * Mirrors the Quotem app's mailer pattern. Reads SMTP creds from env with
 * dual naming for compatibility:
 *   - SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS  (preferred)
 *   - EMAIL_SMTP / EMAIL_PORT / EMAIL_USER / EMAIL_PASS  (fallback)
 *
 * IONOS-specific notes:
 *   - PASS must be an IONOS App Password (not the regular mailbox password).
 *   - Port 587 → STARTTLS (default). Port 465 → implicit SSL.
 *   - host defaults to smtp.ionos.co.uk.
 */
'use strict';
const nodemailer = require('nodemailer');

let cachedTransporter = null;
let cachedSig = null;

function loadConfig() {
    const host = process.env.SMTP_HOST || process.env.EMAIL_SMTP || 'smtp.ionos.co.uk';
    const port = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || '587', 10);
    const user = process.env.SMTP_USER || process.env.EMAIL_USER || '';
    const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS || '';
    return { host, port, user, pass };
}

function isConfigured() {
    const cfg = loadConfig();
    return Boolean(cfg.host && cfg.user && cfg.pass);
}

function getTransporter() {
    const cfg = loadConfig();
    if (!cfg.host || !cfg.user || !cfg.pass) {
        throw new Error('Mailer not configured: set SMTP_HOST, SMTP_USER and SMTP_PASS in env. PASS must be an IONOS App Password.');
    }
    const sig = `${cfg.host}|${cfg.port}|${cfg.user}`;
    if (cachedTransporter && cachedSig === sig) return cachedTransporter;
    cachedTransporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.port === 465,
        requireTLS: cfg.port === 587,
        auth: { user: cfg.user, pass: cfg.pass },
    });
    cachedSig = sig;
    return cachedTransporter;
}

async function sendMail({ to, subject, text, html, from }) {
    const transporter = getTransporter();
    const cfg = loadConfig();
    return transporter.sendMail({
        from: from || `Quotem-AI <${cfg.user}>`,
        to,
        subject,
        text,
        html,
    });
}

module.exports = { sendMail, isConfigured };
