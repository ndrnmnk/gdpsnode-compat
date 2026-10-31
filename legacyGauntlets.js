'use strict';

const crypto = require('node:crypto');

function prepare(db, body, gameVersion) {
    if (typeof body.gauntlet !== 'string' || !/^[1-9]\d*$/.test(body.gauntlet)) return null;
    const id = Number(body.gauntlet);
    if (!Number.isSafeInteger(id)) return null;
    const gauntlet = db.prepare('SELECT * FROM gauntlets WHERE ID = ?').get(id);
    if (!gauntlet) return null;
    const levelIDs = [1, 2, 3, 4, 5].map(i => gauntlet[`level${i}`]);
    for (const levelID of levelIDs) {
        if (!Number.isSafeInteger(levelID) || levelID <= 0) return null;
        const level = db.prepare('SELECT accountID, gameVersion, levelLength, unlisted FROM levels WHERE levelID = ?').get(levelID);
        if (!level || level.gameVersion > gameVersion || level.levelLength === 5 || level.unlisted !== 0) return null;
        const owner = db.prepare('SELECT isDisabled FROM accounts WHERE accountID = ?').get(level.accountID);
        if (!owner || owner.isDisabled) return null;
    }
    body.type = '10';
    body.str = levelIDs.join(',');
    body.page = '0';
    return { id, levelIDs };
}

function rewrite(sections, gauntlet) {
    if (sections.length !== 5 || !sections[0]) return false;
    const levels = new Map(sections[0].split('|').map(row => {
        const entries = row.split(':');
        const fields = {};
        for (let i = 0; i + 1 < entries.length; i += 2) fields[entries[i]] = entries[i + 1];
        return [Number(fields['1']), { row, fields }];
    }));
    let hashInput = '';
    const ordered = [];
    for (const id of gauntlet.levelIDs) {
        const level = levels.get(id);
        if (!level) return false;
        const text = String(id);
        hashInput += text[0] + text.at(-1) + (level.fields['18'] || '0') + (level.fields['38'] || '0');
        ordered.push(`44:${gauntlet.id}:${level.row}`);
    }
    sections[0] = ordered.join('|');
    sections[3] = '5:0:10';
    sections[4] = crypto.createHash('sha1').update(hashInput + 'xI25fpAapCQg').digest('hex');
    return true;
}

module.exports = { prepare, rewrite };
