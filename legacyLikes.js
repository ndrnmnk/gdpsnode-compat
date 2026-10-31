'use strict';

function initialize(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS legacy_compat_like_counts (
        deviceHash TEXT NOT NULL,
        itemID INTEGER NOT NULL,
        type INTEGER NOT NULL,
        votes INTEGER NOT NULL,
        PRIMARY KEY (deviceHash, itemID, type)
    )`);
}

// Historical anonymous votes are actions, not one immutable vote per account.
// Match the PHP reference's limit of three actions per identity and item.
function vote(db, deviceHash, body, authenticatedAccountID = null) {
    if (typeof body.itemID !== 'string' || !/^\d+$/.test(body.itemID)) return false;
    const itemID = Number(body.itemID);
    if (!Number.isSafeInteger(itemID) || itemID <= 0 || !['1', '2'].includes(body.type) || !['0', '1'].includes(body.like)) return false;
    const type = Number(body.type);
    const table = type === 1 ? 'levels' : 'comments';
    const column = type === 1 ? 'levelID' : 'commentID';
    const contentType = type === 1 ? 'likes_levels' : 'likes_comments';

    return db.transaction(() => {
        // The optional account ID is supplied only after the middleware verifies its credential.
        const guest = authenticatedAccountID === null
            ? db.prepare(`SELECT a.accountID, a.isDisabled FROM legacy_compat_guests g
                JOIN accounts a ON a.accountID = g.accountID WHERE g.deviceHash = ?`).get(deviceHash)
            : db.prepare('SELECT accountID, isDisabled FROM accounts WHERE accountID = ?').get(authenticatedAccountID);
        if (authenticatedAccountID !== null && !guest) return false;
        if (guest?.isDisabled) return false;
        const tracked = db.prepare(`SELECT votes FROM legacy_compat_like_counts
            WHERE deviceHash = ? AND itemID = ? AND type = ?`).get(deviceHash, itemID, type);
        // An old plugin/core marker represents one already-counted action, not a
        // permanent veto. Preserve its contribution and consume one of the three slots.
        const previous = guest && db.prepare(`SELECT 1 FROM content_increments
            WHERE accountID = ? AND contentID = ? AND contentType = ?`).get(guest.accountID, itemID, contentType);
        const used = tracked ? tracked.votes : previous ? 1 : 0;
        if (used >= 3) return false;

        const operation = body.like === '1' ? '+' : '-';
        const updated = db.prepare(`UPDATE ${table} SET likes = likes ${operation} 1 WHERE ${column} = ?`).run(itemID);
        if (!updated.changes) return false;
        db.prepare(`INSERT INTO legacy_compat_like_counts (deviceHash, itemID, type, votes)
            VALUES (?, ?, ?, ?) ON CONFLICT(deviceHash, itemID, type)
            DO UPDATE SET votes = excluded.votes`).run(deviceHash, itemID, type, used + 1);
        if (type === 2) {
            db.prepare('UPDATE comments SET isSpam = CASE WHEN likes < -3 THEN 1 ELSE 0 END WHERE commentID = ?').run(itemID);
        }
        return true;
    })();
}

module.exports = { initialize, vote };
