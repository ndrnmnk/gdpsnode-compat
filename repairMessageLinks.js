'use strict';

// Older installs forwarded DMs before keeping IDs. Recover only exact one-to-one matches.
module.exports = function repairMessageLinks(db, link, readBody) {
    db.transaction(() => {
        const matches = [];
        const counts = new Map();
        const messages = db.prepare(`SELECT m.* FROM messages m
            LEFT JOIN legacy_compat_message_links l ON l.legacyID = m.ID
            WHERE m.accID != 71 AND l.legacyID IS NULL`).all();
        for (const message of messages) {
            const subject = Buffer.from(message.subject, 'base64').toString('utf8');
            const body = readBody(message.body);
            const text = /^(?:Re:\s*)*New DM$/i.test(subject.trim()) ? body : `${subject}\n\n${body}`;
            const candidates = db.prepare(`SELECT tm.messageID, tm.content FROM thread_messages tm
                JOIN threads t ON t.threadID = tm.threadID
                JOIN thread_members s ON s.threadID = t.threadID AND s.accountID = ?
                JOIN thread_members r ON r.threadID = t.threadID AND r.accountID = ?
                LEFT JOIN legacy_compat_message_links l ON l.messageID = tm.messageID
                WHERE t.isDM = 1 AND tm.accountID = ? AND tm.timestamp = ?
                    AND tm.isSystem = 0 AND l.messageID IS NULL`).all(message.accID, message.toAccountID, message.accID, message.timestamp)
                .filter(candidate => Buffer.from(candidate.content, 'base64').toString('utf8') === text);
            if (candidates.length !== 1) continue;
            const id = candidates[0].messageID;
            matches.push([id, message.ID]);
            counts.set(id, (counts.get(id) || 0) + 1);
        }
        for (const [id, legacyID] of matches) if (counts.get(id) === 1) link(id, [legacyID]);
    })();
};
