'use strict';

const targets = new Set([
    '/getGJLevels21.php', '/downloadGJLevel22.php', '/getGJComments21.php', '/getGJCommentHistory.php',
    '/getGJScores20.php', '/getGJUsers20.php', '/getGJUserInfo20.php', '/getGJUserList20.php'
]);

function values(row, separator) {
    const parts = row.split(separator);
    const result = {};
    for (let i = 0; i + 1 < parts.length; i += 2) result[parts[i]] = parts[i + 1];
    return result;
}

function change(row, separator, callback) {
    const parts = row.split(separator);
    for (let i = 0; i + 1 < parts.length; i += 2) parts[i + 1] = callback(parts[i], parts[i + 1]);
    return parts.join(separator);
}

function rewrite(db, target, text) {
    if (!targets.has(target) || typeof text !== 'string' || /^-\d+$/.test(text)) return text;
    const guests = new Map(db.prepare(`SELECT g.accountID, p.userName FROM legacy_compat_guests g
        JOIN profiles p ON p.accountID = g.accountID`).all().map(row => [row.accountID,
        row.userName && !row.userName.startsWith('_legacy_') ? row.userName : 'Player']));
    if (!guests.size) return text;
    const sections = text.split('#');
    const creator = row => {
        const parts = row.split(':');
        const name = guests.get(Number(parts[0]) - 1);
        return name && parts.length === 3 ? `${parts[0]}:${name}:0` : row;
    };
    if (target === '/getGJLevels21.php') {
        if (sections.length === 5) sections[1] = sections[1].split('|').map(creator).join('|');
    } else if (target === '/downloadGJLevel22.php') {
        if (sections.length === 4) sections[3] = creator(sections[3]);
    } else if (target === '/getGJComments21.php' || target === '/getGJCommentHistory.php') {
        sections[0] = sections[0].split('|').map(row => {
            const [comment, profile] = row.split(':');
            const name = guests.get(Number(values(comment, '~')['3']) - 1);
            if (!name || !profile) return row;
            return `${comment}:${change(profile, '~', (key, value) => key === '1' ? name : key === '16' ? '0' : value)}`;
        }).join('|');
        if (sections.length === 3) sections[1] = sections[1].split('|').map(creator).join('|');
    } else {
        sections[0] = sections[0].split('|').map(row => {
            const name = guests.get(Number(values(row, ':')['2']) - 1);
            if (!name) return row;
            return change(row, ':', (key, value) => key === '1' ? name : key === '16' || target === '/getGJScores20.php' && key === '7' ? '0' : value);
        }).join('|');
    }
    return sections.join('#');
}

module.exports = { targets, rewrite };
