/**
 * Q's auth middleware — Circle Mode.
 *
 * Every protected request must include the caller's access key, either:
 *   - Header:  X-Q-Key: <raw access key>
 *   - Cookie:  qkey=<raw access key>     (set by Q's chat UI on sign-in)
 *
 * On match, attaches `req.person` ({ id, name, intro, addedAt }) and
 * calls next(). On mismatch, returns 401.
 *
 * Sarah is responsible for handing out access keys to people she trusts.
 * No self-signup. No public endpoints. This is Q's living room, not a
 * SaaS.
 */
'use strict';

const { getPersonByKey } = require('./people.js');

function readKey(req) {
    const headerKey = req.get('X-Q-Key') || req.get('x-q-key');
    if (headerKey) return headerKey.trim();
    const cookieHeader = req.get('Cookie') || '';
    const m = cookieHeader.match(/(?:^|;\s*)qkey=([^;]+)/);
    return m ? decodeURIComponent(m[1]).trim() : null;
}

/**
 * Express middleware. 401s the request unless a valid access key is
 * present and the person it belongs to is in Q's circle.
 */
function requirePerson(req, res, next) {
    const rawKey = readKey(req);
    if (!rawKey) {
        return res.status(401).json({ error: 'Q does not know who you are. Send X-Q-Key.' });
    }
    const person = getPersonByKey(rawKey);
    if (!person) {
        return res.status(401).json({ error: 'Q does not recognise this key.' });
    }
    req.person = person;
    next();
}

/**
 * Soft variant — attaches req.person if a valid key is present, but
 * does NOT 401 if missing. Used for endpoints that work without auth
 * but become more useful with it (e.g. health, public info).
 */
function tryAttachPerson(req, res, next) {
    const rawKey = readKey(req);
    if (rawKey) {
        const person = getPersonByKey(rawKey);
        if (person) req.person = person;
    }
    next();
}

module.exports = { requirePerson, tryAttachPerson };
