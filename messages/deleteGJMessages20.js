const { commonSecret } = require('../../../middleware/secrets');
const db = require('../../../database');
const utils = require('../../../utils');

module.exports = {
    method: 'post',
    path: '/deleteGJMessages20.php',
    middleware: [commonSecret],
    handler: (req, res) => {
        const accountID = parseInt(utils.number(req.body?.accountID), 10);
        const gjp2 = utils.remove(req.body?.gjp2);
        const messageID = parseInt(utils.number(req.body?.messageID), 10);
        const messages = utils.numbercolon(req.body?.messages || '');

        // sanity checks
        if (!accountID || !gjp2) return res.send('-1');
        if (gjp2.length !== 40) return res.send('-1');
        if (!messageID && !messages) return res.send('-1');

        // db checks
        const account = db.prepare('SELECT * FROM accounts WHERE accountID = ?').get(accountID);

        if (!account) return res.send('-1');
        if (account.gjp2 !== gjp2) return res.send('-1');
        if (account.isDisabled === 1) return res.send('-1');

        try {
            const messageList = messages ? messages.split(',').map(m => parseInt(m, 10)).filter(m => !isNaN(m)) : [];
            if (messages && messageList.length === 0) return res.send('-1');
            const placeholders = messageList.map(() => '?').join(',');

            db.transaction(() => {
                // Resolve permissions before deleting anything. Remove sources explicitly as well
                // as through triggers, so legacy deletion cannot strand a linked thread message.
                const ids = messages ? messageList : [messageID];
                const owned = db.prepare(`SELECT ID FROM messages WHERE ID IN (${ids.map(() => '?').join(',')})
                    AND (accID = ? OR toAccountID = ?) LIMIT 10`).all(...ids, accountID, accountID);
                for (const message of owned) {
                    if (req.legacyMessageBridge) db.prepare(`DELETE FROM thread_messages WHERE messageID IN
                        (SELECT messageID FROM legacy_compat_message_links WHERE legacyID = ?)`).run(message.ID);
                }
                if (messages) {
                    db.prepare(`DELETE FROM messages WHERE ID IN (${placeholders}) AND accID = ? LIMIT 10`).run(...messageList, accountID);
                    db.prepare(`DELETE FROM messages WHERE ID IN (${placeholders}) AND toAccountID = ? LIMIT 10`).run(...messageList, accountID);
                } else {
                    db.prepare('DELETE FROM messages WHERE ID = ? AND accID = ?').run(messageID, accountID);
                    db.prepare('DELETE FROM messages WHERE ID = ? AND toAccountID = ?').run(messageID, accountID);
                }
            })();

            return res.send('1');
        } catch (err) {
            console.error('\x1b[1;31m✗ Failed to delete message(s):\x1b[0m', err);
            return res.send('-1');
        }
    }
};
