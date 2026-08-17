#!/usr/bin/env node
// Run Q LOCALLY with the live keys — so testing never has to wait for, or
// suffer, a Railway redeploy (Sarah, 17 Aug: "I think we need to work on
// local").
//
//   1. once:  railway variables --kv > .env.local        (git-ignored; never printed)
//   2. then:  npm run local                              → http://localhost:8090
//
// Everything from .env.local is loaded, then two things are overridden so the
// live volume is never touched: the data dir becomes ./.local-data (git-ignored)
// and the port 8090. First boot of an empty data dir prints a bootstrap
// password in this terminal — log in with that.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env.local');
if (!fs.existsSync(envFile)) {
  console.error('No .env.local — run:  railway variables --kv > .env.local   (in the repo root) then try again.');
  process.exit(1);
}
require('dotenv').config({ path: envFile });
const dataDir = process.env.LOCAL_DATA_DIR || path.join(root, '.local-data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;
process.env.PORT = process.env.LOCAL_PORT || '8090';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
delete process.env.RAILWAY_PUBLIC_DOMAIN;
console.log('[local] data dir  = ' + dataDir);
console.log('[local] open      = http://localhost:' + process.env.PORT + '/writer');
require(path.join(root, 'server', 'index.js'));
