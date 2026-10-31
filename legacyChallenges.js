'use strict';

const crypto = require('node:crypto');
const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');
const defaults = [
    { type: 1, amount: 500, reward: 5, name: 'Orb Collector' },
    { type: 2, amount: 6, reward: 5, name: 'Coin Collector' },
    { type: 3, amount: 10, reward: 5, name: 'Star Collector' }
];
const xor = buffer => Buffer.from(buffer.map((value, i) => value ^ '19847'.charCodeAt(i % 5)));

function response(db, body, now = Date.now()) {
    if (body.secret !== 'Wmfd2893gb7') return '-1';
    const rawAccountID = body.accountID == null || body.accountID === '' ? '0' : body.accountID;
    if (typeof rawAccountID !== 'string' || !/^\d+$/.test(rawAccountID)) return '-1';
    const accountID = Number(rawAccountID);
    if (!Number.isSafeInteger(accountID)) return '-1';
    const udid = body.udid;
    if (typeof udid !== 'string' || !udid || udid.length > 256 || /^\d+$/.test(udid) || /[:,|#\0]/.test(udid)) return '-1';
    if (typeof body.chk !== 'string' || body.chk.length <= 5 || body.chk.length > 512) return '-1';
    const payload = body.chk.slice(5);
    if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(payload)) return '-1';
    const nonce = xor(Buffer.from(payload, 'base64')).toString('utf8');
    if (!nonce || /[:,|#\0]/.test(nonce)) return '-1';

    let userID = 0;
    if (accountID) {
        const account = db.prepare('SELECT gjp2, isDisabled FROM accounts WHERE accountID = ?').get(accountID);
        if (!account || account.isDisabled || !body.gjp2 || account.gjp2 !== body.gjp2) return '-1';
        userID = accountID + 1;
    } else {
        const guest = db.prepare(`SELECT a.accountID, a.isDisabled FROM legacy_compat_guests g
            JOIN accounts a ON a.accountID = g.accountID WHERE g.deviceHash = ?`).get(sha1(udid));
        if (guest?.isDisabled) return '-1';
        if (guest) userID = guest.accountID + 1;
        else if (typeof body.uuid === 'string' && /^\d+$/.test(body.uuid) && Number.isSafeInteger(Number(body.uuid))) userID = Number(body.uuid);
    }

    const quests = db.prepare('SELECT type, amount, reward, name FROM quests').all()
        .filter(q => [1, 2, 3].includes(q.type) && Number.isInteger(q.amount) && q.amount > 0 &&
            Number.isInteger(q.reward) && q.reward > 0 && typeof q.name === 'string' && q.name.trim())
        .map(q => ({ ...q, name: q.name.replace(/[:,|#\0]/g, ' ').trim().slice(0, 64) }))
        .filter(q => q.name);
    const missingTypes = defaults.filter(fallback => !quests.some(q => q.type === fallback.type));
    for (const fallback of [...missingTypes, ...defaults]) {
        if (quests.length >= 3) break;
        quests.push(fallback);
    }
    // Quest IDs, selection and expiration share the same UTC day boundary.
    const day = Math.floor(now / 86400000);
    const firstID = (day - Math.floor(Date.UTC(2000, 11, 17) / 86400000)) * 3;
    const timeLeft = 86400 - Math.floor(now / 1000) % 86400;
    const key = q => sha1(`${day}:${q.type}:${q.amount}:${q.reward}:${q.name}`);
    const selected = quests.sort((a, b) => key(a).localeCompare(key(b))).slice(0, 3);
    const records = selected.map((q, i) => `${firstID + i},${q.type},${q.amount},${q.reward},${q.name}`);
    const plain = `SaKuJ:${userID}:${nonce}:${udid}:${accountID}:${timeLeft}:${records.join(':')}`;
    const encoded = xor(Buffer.from(plain)).toString('base64');
    return `SaKuJ${encoded}|${sha1(encoded + 'oC36fpYaPtdg')}`;
}

module.exports = { response };
