'use strict';

/**
 * Q AUDIO FETCH
 *
 * Given a URL (any audio source yt-dlp supports), download a short slice and
 * trim to ~15 seconds of mono speech ready for voice cloning.
 *
 * Returns a Buffer of WAV bytes (22050 Hz, mono).
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const path = require('path');

const FETCH_WINDOW_SECONDS = 30;   // how much of the source to pull at the chosen start point
const TRIM_LENGTH_SECONDS  = 15;   // length of the final reference clip
const TRIM_PAD_SECONDS     = 3;    // small offset into the fetched window so we don't catch a hard cut
const MAX_FILESIZE         = '50M';

/**
 * Parse a start-time string into seconds.
 * Accepts:  "90"  "90s"  "1:30"  "1m30s"
 */
function parseStartTime(input) {
    if (input == null) return 0;
    if (typeof input === 'number' && isFinite(input)) return Math.max(0, Math.floor(input));
    const s = String(input).trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (/^\d+s$/i.test(s)) return parseInt(s, 10);
    const colon = s.match(/^(\d+):(\d{1,2})$/);                       // "1:30" or "12:05"
    if (colon) return parseInt(colon[1], 10) * 60 + parseInt(colon[2], 10);
    const colonHour = s.match(/^(\d+):(\d{2}):(\d{2})$/);              // "1:23:45"
    if (colonHour) return parseInt(colonHour[1], 10) * 3600 + parseInt(colonHour[2], 10) * 60 + parseInt(colonHour[3], 10);
    const m = s.match(/^(?:(\d+)m)?\s*(?:(\d+)s)?$/i);                 // "1m30s" / "30s" / "2m"
    if (m && (m[1] || m[2])) return (parseInt(m[1] || '0', 10) * 60) + parseInt(m[2] || '0', 10);
    return 0;
}

function runCmd(cmd, args, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        let stdout = '';
        const t = setTimeout(() => {
            p.kill('SIGKILL');
            reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        p.stdout.on('data', d => { stdout += d.toString(); });
        p.stderr.on('data', d => { stderr += d.toString(); });
        p.on('error', err => { clearTimeout(t); reject(err); });
        p.on('close', code => {
            clearTimeout(t);
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${cmd} exit ${code}: ${(stderr || stdout).slice(-400)}`));
        });
    });
}

/**
 * Download a short audio slice from a URL and return a 15-second mono wav Buffer
 * suitable for voice cloning.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {string|number} [options.startTime]  - Where in the source to begin (e.g. "1:30", "90", "1m30s")
 * @returns {Promise<Buffer>}
 */
async function fetchAudioClip(url, options = {}) {
    if (!url || typeof url !== 'string') throw new Error('url is required');

    const startSec = parseStartTime(options.startTime);
    const endSec   = startSec + FETCH_WINDOW_SECONDS;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'q-audio-'));
    const downloadStem = path.join(tmpDir, 'raw');
    const trimmedPath  = path.join(tmpDir, 'trimmed.wav');

    try {
        // Step 1: pull a small slice of audio only — starting at the user's chosen point.
        await runCmd('yt-dlp', [
            '-x',
            '--audio-format', 'wav',
            '--audio-quality', '0',
            '--download-sections', `*${startSec}-${endSec}`,
            '--max-filesize', MAX_FILESIZE,
            '--no-playlist',
            '--no-warnings',
            '-o', `${downloadStem}.%(ext)s`,
            url,
        ], { timeoutMs: 90000 });

        // Resolve the output filename — yt-dlp will write raw.wav (or raw.<ext>).
        const candidates = (await fs.readdir(tmpDir)).filter(f => f.startsWith('raw.'));
        if (candidates.length === 0) throw new Error('Download produced no file');
        const downloadedPath = path.join(tmpDir, candidates[0]);

        // Step 2: drop a small lead-in pad, take 15s, downmix to mono 22050Hz,
        // and run silenceremove so a residual silent gap at the start gets dropped.
        await runCmd('ffmpeg', [
            '-y',
            '-i', downloadedPath,
            '-ss', String(TRIM_PAD_SECONDS),
            '-t',  String(TRIM_LENGTH_SECONDS),
            '-af', 'silenceremove=start_periods=1:start_duration=0.3:start_threshold=-40dB',
            '-ar', '22050',
            '-ac', '1',
            '-vn',
            trimmedPath,
        ], { timeoutMs: 30000 });

        return await fs.readFile(trimmedPath);
    } finally {
        try { fsSync.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

module.exports = { fetchAudioClip, parseStartTime };
