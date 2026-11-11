const { commonSecret } = require('../../../middleware/secrets');
const db = require('../../../database');
const utils = require('../../../utils');

const welcomeMessageSender = {
    accountID: 71,
    userName: 'GDPSnode Notifications',
    subject: 'V2VsY29tZSB0byBHRFBTbm9kZSE='
};

module.exports = {
    method: 'post',
    path: '/downloadGJMessage20.php',
    middleware: [commonSecret],
    handler: (req, res) => {
        const accountID = parseInt(utils.number(req.body?.accountID), 10);
        const gjp2 = utils.remove(req.body?.gjp2);
        const messageID = parseInt(utils.number(req.body?.messageID), 10);

        // sanity checks
        if (!accountID || !gjp2 || !messageID) return res.send('-1');
        if (gjp2.length !== 40) return res.send('-1');

        // db checks
        const account = db.prepare('SELECT * FROM accounts WHERE accountID = ?').get(accountID);

        if (!account) return res.send('-1');
        if (account.gjp2 !== gjp2) return res.send('-1');
        if (account.isDisabled === 1) return res.send('-1');

        try {
            const message = db.prepare('SELECT accID, toAccountID, timestamp, userName, ID, subject, isNew, body FROM messages WHERE ID = ? AND (accID = ? OR toAccountID = ?)').get(messageID, accountID, accountID);

            if (!message) return res.send('-1');

            const actualIsSender = message.accID === accountID ? 1 : 0;
            const otherAccountID = actualIsSender ? message.toAccountID : message.accID;
            if (!actualIsSender) {
                db.prepare('UPDATE messages SET isNew = 0 WHERE ID = ? AND toAccountID = ?').run(messageID, accountID);
                message.isNew = 0;
            }
            let otherProfile = db.prepare('SELECT userName, accountID FROM profiles WHERE accountID = ?').get(otherAccountID);
            if (!otherProfile && otherAccountID === welcomeMessageSender.accountID) {
                otherProfile = welcomeMessageSender;
            }

            if (!otherProfile) return res.send('-1');

            return res.send(`6:${otherProfile.userName}:3:${otherProfile.accountID + 1}:2:${otherProfile.accountID}:1:${message.ID}:4:${message.subject}:8:${message.isNew}:9:${actualIsSender}:5:${message.body}:7:${utils.getRelative(message.timestamp)}`);
        } catch (err) {
            console.error('\x1b[1;31m✗ Failed to download message:\x1b[0m', err);
            return res.send('-1');
        }
    }
};
