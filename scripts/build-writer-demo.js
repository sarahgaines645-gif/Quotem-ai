#!/usr/bin/env node
/**
 * build-writer-demo.js — generate the REAL half of the Introduction project
 * template, ONCE: the brief (the real brief reader on the demo task) and the
 * mark (the real marker on the demo essay). Writes plugins/writer-demo-template.json.
 *
 * Costs two model calls (a brief read + a full Mark & fix). Run by hand, with
 * Sarah's say-so — never from the app.
 *
 *   node scripts/build-writer-demo.js          (reads .env.local for the keys)
 */
'use strict';
const fs = require('fs');
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') }); } catch (_) {}
const qWriter = require('../plugins/q-writer');
const demo = require('../plugins/writer-demo');

(async () => {
    const out = path.join(__dirname, '..', 'plugins', 'writer-demo-template.json');
    const t0 = Date.now();
    console.log('[demo] reading the brief…');
    const brief = await qWriter.analyseAndBrief(demo.DEMO_TASK);
    console.log('[demo] brief: ' + (brief && brief.title) + ' — ' + ((brief && brief.criteria) || []).length + ' parts, in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    const t1 = Date.now();
    console.log('[demo] marking the essay…');
    const mark = await qWriter.markLikeMarker({ brief, essay: null, docText: demo.demoDocText(), gradeScheme: 'as the brief says', plans: {}, taskText: demo.DEMO_TASK });
    console.log('[demo] mark: ' + (mark && mark.overall && (mark.overall.label || mark.overall.band)) + ' — ' + ((mark && mark.perCriterion) || []).map(p => p.criterionId + ':' + (p.label || p.band)).join(' ') + ', in ' + ((Date.now() - t1) / 1000).toFixed(1) + 's');
    const tpl = { builtAt: new Date().toISOString(), brief, lastMark: { ...mark, markedAt: Date.now() } };
    fs.writeFileSync(out, JSON.stringify(tpl, null, 1));
    console.log('[demo] wrote ' + out + ' (' + fs.statSync(out).size + ' bytes)');
})().catch(e => { console.error('[demo] FAILED: ' + (e && e.message)); process.exit(1); });
