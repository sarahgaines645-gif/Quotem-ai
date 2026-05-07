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

const MAX_DOWNLOAD_SECONDS = 30;   // how much of the source to pull
const TRIM_START_SECONDS   = 5;    // skip past intros / silence
const TRIM_LENGTH_SECONDS  = 15;   // length of the reference clip
const MAX_FILESIZE         = '25M';

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
 * @returns {Promise<Buffer>}
 */
async function fetchAudioClip(url) {
    if (!url || typeof url !== 'string') throw new Error('url is required');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'q-audio-'));
    const downloadStem = path.join(tmpDir, 'raw');
    const trimmedPath  = path.join(tmpDir, 'trimmed.wav');

    try {
        // Step 1: pull a small slice of audio only — never the whole video.
        await runCmd('yt-dlp', [
            '-x',
            '--audio-format', 'wav',
            '--audio-quality', '0',
            '--download-sections', `*0-${MAX_DOWNLOAD_SECONDS}`,
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

        // Step 2: trim to a clean middle slice + downmix to mono 22050 Hz.
        await runCmd('ffmpeg', [
            '-y',
            '-i', downloadedPath,
            '-ss', String(TRIM_START_SECONDS),
            '-t',  String(TRIM_LENGTH_SECONDS),
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

module.exports = { fetchAudioClip };
