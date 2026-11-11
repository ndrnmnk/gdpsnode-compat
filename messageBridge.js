'use strict';

const SYSTEM_ID = 71;
const SYSTEM_NAME = 'GDPSnode Notifications';
const encode = text => Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const decode = text => Buffer.from(text, 'base64').toString('utf8');
const legacyToken = char => char.codePointAt(0) < 128 ? char : Array.from(Buffer.from(char), byte => `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
const welcome = 'Welcome! Send message_bridge 1 to forward DMs to legacy messages, or message_bridge 0 to stop. Legacy messages appear in DMs too. Send legacy_notif 0 to mute legacy notifications, or legacy_notif 1 to restore them. Send subscribe_news to receive new local news articles.';
// Legacy message bodies use XOR encryption before URL-safe base64 encoding.
function legacyBody(text) {
    const bytes = Buffer.from(text);
    return encode(Buffer.from(bytes.map((byte, i) => byte ^ '14251'.charCodeAt(i % 5))));
}
function readLegacyBody(body) {
    return Buffer.from(Buffer.from(body, 'base64').map((byte, i) => byte ^ '14251'.charCodeAt(i % 5))).toString('utf8');
}

module.exports = function install(api) {
    const db = api.db;
    db.exec('CREATE TABLE IF NOT EXISTS legacy_compat_message_bridge (accountID INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)');
    db.exec('CREATE TABLE IF NOT EXISTS legacy_compat_notifications (accountID INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)');
    let translatingLegacy = false;
    function notificationsEnabled(accountID) {
        return db.prepare('SELECT enabled FROM legacy_compat_notifications WHERE accountID = ?').get(accountID)?.enabled !== 0;
    }
    function forwardLegacy(sender, recipient, subject, body) {
        let thread = db.prepare(`SELECT t.threadID FROM threads t
            JOIN thread_members s ON s.threadID = t.threadID AND s.accountID = ? AND s.status IN (0, 1)
            JOIN thread_members r ON r.threadID = t.threadID AND r.accountID = ? AND r.status IN (0, 1)
            WHERE t.isDM = 1 ORDER BY t.threadID LIMIT 1`).get(sender, recipient);
        const now = Math.floor(Date.now() / 1000);
        if (!thread) {
            const result = db.prepare('INSERT INTO threads (isDM, ownerID, createdAt, updatedAt) VALUES (1, ?, ?, ?)').run(sender, now, now);
            thread = { threadID: Number(result.lastInsertRowid) };
            db.prepare('INSERT INTO thread_members (threadID, accountID, status, joinedAt) VALUES (?, ?, 1, ?), (?, ?, 1, ?)')
                .run(thread.threadID, sender, now, thread.threadID, recipient, now);
        }
        const cursor = db.prepare('SELECT COALESCE(MAX(messageID), 0) AS id FROM thread_messages WHERE threadID = ?').get(thread.threadID).id;
        // Keep the original legacy copy without echoing this translated DM back into that inbox.
        translatingLegacy = true;
        try {
            const title = decode(subject);
            const text = /^(?:Re:\s*)*New DM$/i.test(title.trim())
                ? readLegacyBody(body) : `${title}\n\n${readLegacyBody(body)}`;
            db.prepare('INSERT INTO thread_messages (threadID, accountID, content, timestamp, isSystem) VALUES (?, ?, ?, ?, 0)')
                .run(thread.threadID, sender, encode(text), now);
        } finally {
            translatingLegacy = false;
        }
        db.prepare('UPDATE threads SET updatedAt = ?, mv = mv + 1 WHERE threadID = ?').run(now, thread.threadID);
        db.prepare(`UPDATE thread_members SET clearedBeforeID = MAX(clearedBeforeID, ?), lastReadMessageID = MAX(lastReadMessageID, ?)
            WHERE threadID = ? AND hidden = 1`).run(cursor, cursor, thread.threadID);
        db.prepare('UPDATE thread_members SET status = 1, hidden = 0, joinedAt = CASE WHEN joinedAt = 0 THEN ? ELSE joinedAt END WHERE threadID = ?')
            .run(now, thread.threadID);
    }
    function legacy(sender, name, recipient, subject, text, footer = '') {
        // A classic upload accepts at most 50 base64 characters in the subject.
        let title = '';
        for (const char of subject) {
            const token = legacyToken(char);
            if (title.length + token.length > 36) break;
            title += token;
        }
        // Escape UTF-8 bytes for old fonts; keep each character's escape sequence together.
        const chunks = [];
        let chunk = '';
        for (const char of text) {
            const token = legacyToken(char);
            if (chunk.length + token.length > 195) { chunks.push(chunk); chunk = ''; }
            chunk += token;
        }
        chunks.push(chunk);
        if (footer) {
            const suffix = `\n\n${Array.from(footer, legacyToken).join('')}`;
            if (chunks[chunks.length - 1].length + suffix.length > 195) chunks.push(suffix.trimStart());
            else chunks[chunks.length - 1] += suffix;
        }
        for (const part of chunks) db.prepare(`INSERT INTO messages (subject, body, accID, userName, toAccountID, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)`).run(encode(title), legacyBody(part), sender, name, recipient, Math.floor(Date.now() / 1000));
    }
    const groups = require('./groupBridge')(db, legacy);
    const news = require('./newsBridge')(api, legacy);
    function systemDM(accountID, text) {
        let thread = db.prepare(`SELECT t.threadID FROM threads t JOIN thread_members m ON m.threadID = t.threadID
            WHERE t.isDM = 1 AND t.ownerID = 71 AND m.accountID = ?`).get(accountID);
        const now = Math.floor(Date.now() / 1000);
        if (!thread) {
            const result = db.prepare('INSERT INTO threads (isDM, ownerID, createdAt, updatedAt) VALUES (1, 71, ?, ?)').run(now, now);
            thread = { threadID: Number(result.lastInsertRowid) };
            db.prepare('INSERT INTO thread_members (threadID, accountID, status, joinedAt) VALUES (?, ?, 1, ?), (?, 71, 1, ?)')
                .run(thread.threadID, accountID, now, thread.threadID, now);
        }
        const result = db.prepare('INSERT INTO thread_messages (threadID, accountID, content, timestamp, isSystem) VALUES (?, 71, ?, ?, 0)')
            .run(thread.threadID, encode(text), now);
        db.prepare('UPDATE threads SET updatedAt = ?, mv = mv + 1 WHERE threadID = ?').run(now, thread.threadID);
        db.prepare('UPDATE thread_members SET hidden = 0 WHERE threadID = ? AND accountID = ?').run(thread.threadID, accountID);
        return `${thread.threadID}:${result.lastInsertRowid}`;
    }
    function command(accountID, text) {
        const match = /^(message_bridge|legacy_notif)\s+([01])$/i.exec(text.trim());
        if (!match) return db.transaction(() => {
            const newsResponse = news.command(accountID, text);
            const response = newsResponse || groups.command(accountID, text);
            if (!response) return null;
            legacy(SYSTEM_ID, SYSTEM_NAME, accountID, newsResponse ? 'News subscription' : 'Group command', response);
            return systemDM(accountID, response);
        })();
        return db.transaction(() => {
            const table = match[1].toLowerCase() === 'legacy_notif' ? 'legacy_compat_notifications' : 'legacy_compat_message_bridge';
            db.prepare(`INSERT INTO ${table} (accountID, enabled) VALUES (?, ?)
                ON CONFLICT(accountID) DO UPDATE SET enabled = excluded.enabled`).run(accountID, Number(match[2]));
            const label = table === 'legacy_compat_notifications' ? 'Legacy notifications' : 'Message bridge';
            const response = `${label} ${match[2] === '1' ? 'enabled' : 'disabled'}.`;
            legacy(SYSTEM_ID, SYSTEM_NAME, accountID, 'Message bridge', response);
            return systemDM(accountID, response);
        })();
    }
    api.registerHook('database:query', query => {
        if (query.method !== 'run') return query;
        const profileInsert = /^\s*INSERT INTO profiles\s*\(accountID, userName\)\s*VALUES/i.test(query.sql);
        const messageInsert = /^\s*INSERT INTO thread_messages\b/i.test(query.sql);
        if (!profileInsert && !messageInsert) return query;
        query.result = query.execute();
        query.handled = true;
        if (!query.result.changes) return query;
        if (profileInsert) {
            const id = Number(query.params[0]);
            const account = db.prepare('SELECT userName FROM accounts WHERE accountID = ?').get(id);
            if (!account || /^_legacy_[a-f0-9]{24}$/.test(account.userName)) return query;
            legacy(SYSTEM_ID, SYSTEM_NAME, id, 'Welcome to GDPSnode!', welcome);
            systemDM(id, welcome);
        } else {
            const message = db.prepare('SELECT * FROM thread_messages WHERE messageID = ?').get(query.result.lastInsertRowid);
            if (message) groups.onMessage(message);
            if (!message || message.isSystem || message.accountID === SYSTEM_ID || translatingLegacy) return query;
            const recipients = db.prepare(`SELECT m.accountID FROM thread_members m JOIN threads t ON t.threadID = m.threadID
                JOIN legacy_compat_message_bridge b ON b.accountID = m.accountID AND b.enabled = 1
                WHERE t.threadID = ? AND t.isDM = 1 AND m.status IN (0, 1) AND m.accountID != ?`).all(message.threadID, message.accountID);
            const sender = db.prepare('SELECT userName FROM profiles WHERE accountID = ?').get(message.accountID);
            for (const recipient of recipients) legacy(message.accountID, sender?.userName || 'Player', recipient.accountID, 'New DM', decode(message.content));
        }
        return query;
    });
    // Intercept only authenticated replies to the virtual system account.
    api.use((req, res, next) => {
        if (req.method !== 'POST') return next();
        // Core treats the virtual account's mS=0/modLevel=0 as friends-only.
        // Clear that client-side status for system DMs, whose commands we accept below.
        if (['/getGJThreads.php', '/getGJThreadMessages.php'].includes(req.path)) {
            const route = req.path;
            const send = res.send;
            res.send = function (value) {
                res.send = send;
                if (typeof value === 'string') {
                    const sections = value.split('#');
                    if (route === '/getGJThreads.php') {
                        sections[0] = sections[0].split('|').map(row => {
                            const fields = row.split(':');
                            if (fields[1] === '71' && fields[9] === '71' && fields[12] === '1' && fields[25] === '4') fields[25] = '0';
                            return fields.join(':');
                        }).join('|');
                    } else if (sections.length === 7) {
                        const fields = sections[4].split(':');
                        const thread = db.prepare('SELECT ownerID, isDM FROM threads WHERE threadID = ?').get(Number(fields[0]));
                        if (thread?.ownerID === SYSTEM_ID && thread.isDM && fields[10] === '4') fields[10] = '0';
                        sections[4] = fields.join(':');
                    }
                    value = sections.join('#');
                }
                return send.call(this, value);
            };
            return next();
        }
        if (req.path !== '/sendGJThreadMessage.php') return next();
        const body = req.body || {};
        const thread = Number(body.threadID) ? db.prepare('SELECT ownerID, isDM FROM threads WHERE threadID = ?').get(Number(body.threadID)) : null;
        if (!(thread?.isDM && thread.ownerID === SYSTEM_ID) && !(Number(body.isDM) === 1 && Number(body.toAccountID) === SYSTEM_ID && !Number(body.threadID))) return next();
        const account = db.prepare('SELECT gjp2, isDisabled FROM accounts WHERE accountID = ?').get(Number(body.accountID));
        if (body.secret !== 'Wmfd2893gb7' || !account || account.isDisabled || account.gjp2 !== body.gjp2) return res.send('-1');
        if (thread && !db.prepare('SELECT 1 FROM thread_members WHERE threadID = ? AND accountID = ? AND status = 1').get(Number(body.threadID), Number(body.accountID))) return res.send('-1');
        return res.send(command(Number(body.accountID), decode(String(body.body || ''))) || '-1');
    });
    return { command, readLegacyBody, forwardLegacy, notificationsEnabled, sendGroup: groups.sendLegacy };
};
