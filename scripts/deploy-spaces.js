#!/usr/bin/env node
/**
 * deploy-spaces.js — Push all of Q's HuggingFace Spaces in one shot.
 *
 * Reads HF_TOKEN and HF_USER from .hf-secrets at the repo root (gitignored).
 * For each Space folder under q-lab/, calls HF's repo-create API and pushes
 * the local files via git. Idempotent — re-running on an existing Space
 * just pushes any new changes.
 *
 * Run: node q-lab/scripts/deploy-spaces.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SECRETS_FILE = path.join(REPO_ROOT, '.hf-secrets');

// image-gen-space removed — image generation now runs via Together AI (FLUX.1-schnell-Free).
const SPACES = [
    { folder: 'voice-cloning-space', name: 'q-voice-cloning', envVar: 'CHATTERBOX_SPACE_URL', sdk: 'gradio' },
    { folder: 'graphics-space',      name: 'q-graphics',      envVar: 'STARVECTOR_SPACE_URL', sdk: 'gradio' },
    { folder: 'music-space',         name: 'q-music',         envVar: 'ACESTEP_SPACE_URL',    sdk: 'gradio' },
    { folder: 'video-space',         name: 'q-video',         envVar: 'WAN_SPACE_URL',        sdk: 'gradio' },
];

function readSecrets() {
    // Prefer .hf-secrets file; fall back to environment variables.
    if (!fs.existsSync(SECRETS_FILE)) {
        const token = process.env.HF_TOKEN;
        const user  = process.env.HF_USER;
        if (token && user) {
            return { HF_TOKEN: token, HF_USER: user };
        }
        console.error('ERROR: .hf-secrets not found and HF_TOKEN/HF_USER not set in environment.');
        console.error('Either create ' + SECRETS_FILE + ' or run:');
        console.error('  $env:HF_TOKEN="hf_..."; $env:HF_USER="your-username"; node scripts/deploy-spaces.js');
        process.exit(1);
    }
    const content = fs.readFileSync(SECRETS_FILE, 'utf8');
    const out = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        out[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
    }
    return out;
}

async function createSpace({ name, sdk, token, user }) {
    const res = await fetch('https://huggingface.co/api/repos/create', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            type: 'space',
            name,
            sdk,
            private: false,
        }),
    });
    if (res.ok) return { ok: true, created: true };
    if (res.status === 409) return { ok: true, created: false };  // already exists
    const text = await res.text();
    return { ok: false, error: 'HTTP ' + res.status + ': ' + text.substring(0, 300) };
}

function pushSpace({ folder, name, token, user }) {
    const sourceDir = path.join(REPO_ROOT, folder);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-deploy-' + name + '-'));
    const remoteUrl = `https://${encodeURIComponent(user)}:${token}@huggingface.co/spaces/${user}/${name}`;

    try {
        execSync(`git clone "${remoteUrl}" "${tempDir}"`, { stdio: ['ignore', 'pipe', 'pipe'] });

        // Copy local files (top-level only — Space folders are flat)
        for (const file of fs.readdirSync(sourceDir)) {
            const src = path.join(sourceDir, file);
            const dst = path.join(tempDir, file);
            const stat = fs.statSync(src);
            if (stat.isFile()) fs.copyFileSync(src, dst);
        }

        execSync('git config user.email "deploy@quotem.local"', { cwd: tempDir, stdio: 'ignore' });
        execSync('git config user.name "Q Deploy"', { cwd: tempDir, stdio: 'ignore' });
        execSync('git config core.autocrlf false', { cwd: tempDir, stdio: 'ignore' });
        execSync('git add .', { cwd: tempDir, stdio: 'ignore' });

        // Check if anything actually changed
        let hasChanges = true;
        try {
            execSync('git diff --cached --quiet', { cwd: tempDir, stdio: 'ignore' });
            hasChanges = false;  // exit 0 = no changes
        } catch { /* exit non-0 = there are changes */ }

        if (!hasChanges) {
            return { ok: true, pushed: false, message: 'no changes' };
        }

        execSync('git commit -m "Deploy from q-lab"', { cwd: tempDir, stdio: 'ignore' });
        execSync('git push', { cwd: tempDir, stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, pushed: true };
    } catch (e) {
        return { ok: false, error: (e.stderr ? e.stderr.toString() : e.message).substring(0, 400) };
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

async function main() {
    const secrets = readSecrets();
    const token = secrets.HF_TOKEN;
    const user = secrets.HF_USER;
    if (!token || token === 'REPLACE_ME') {
        console.error('ERROR: HF_TOKEN not set in .hf-secrets — please fill in.');
        process.exit(1);
    }
    if (!user || user === 'REPLACE_ME') {
        console.error('ERROR: HF_USER not set in .hf-secrets — please fill in your HuggingFace username.');
        process.exit(1);
    }

    console.log(`\nDeploying ${SPACES.length} Spaces under HF user "${user}"...\n`);

    const summary = [];
    for (const space of SPACES) {
        console.log(`━━━ ${space.name} ━━━`);
        const create = await createSpace({ name: space.name, sdk: space.sdk, token, user });
        if (!create.ok) {
            console.error('  ✗ Could not create repo:', create.error);
            summary.push({ space: space.name, status: 'create-failed', error: create.error });
            continue;
        }
        console.log(create.created ? '  ✓ Created repo.' : '  ✓ Repo already existed.');

        const push = pushSpace({ folder: space.folder, name: space.name, token, user });
        if (!push.ok) {
            console.error('  ✗ Push failed:', push.error);
            summary.push({ space: space.name, status: 'push-failed', error: push.error });
            continue;
        }
        const subdomain = `${user}-${space.name}`.toLowerCase();
        const url = `https://${subdomain}.hf.space`;
        console.log(`  ✓ ${push.pushed ? 'Pushed files.' : 'No new changes.'}`);
        console.log(`  → Space URL:    https://huggingface.co/spaces/${user}/${space.name}`);
        console.log(`  → Endpoint URL: ${url}`);
        console.log(`  → Railway env:  ${space.envVar}=${url}`);
        summary.push({ space: space.name, status: 'ok', envVar: space.envVar, url });
        console.log('');
    }

    console.log('━━━ summary ━━━');
    for (const s of summary) {
        console.log(`  ${s.status === 'ok' ? '✓' : '✗'}  ${s.space.padEnd(20)} ${s.status}`);
    }
    console.log('\nHuggingFace will now build each Space in parallel on their side');
    console.log('(~10–25 min each — heavier models like video take longer).');
    console.log('Once built, paste the env-var values above into Railway.\n');
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
