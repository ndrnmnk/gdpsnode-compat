'use strict';

const update = require('../../endpoints/threads/updateGJThread');
const send = require('../../endpoints/threads/sendGJThreadMessage');
const report = require('../../endpoints/misc/reportGJContent');
const threadUtils = require('../../threadUtils');
const encode = value => Buffer.from(value).toString('base64');
const decode = value => Buffer.from(value, 'base64').toString('utf8');

module.exports = function groupBridge(db, legacy) {
    const notify = (accountID, subject, text) => legacy(71, 'GDPSnode Notifications', accountID, subject, text);
    // These synchronous handlers receive credentials only after the plugin authenticates the caller.
    function invoke(endpoint, accountID, body) {
        const account = db.prepare('SELECT gjp2 FROM accounts WHERE accountID = ?').get(accountID);
        let result = '-1';
        endpoint.handler({ body: { ...body, accountID: String(accountID), gjp2: account?.gjp2, secret: 'Wmfd2893gb7' } }, {
            send(value) { result = String(value); return this; }
        });
        return result;
    }
    function access(accountID, groupID) {
        if (!Number.isSafeInteger(groupID) || groupID <= 0) return null;
        const group = threadUtils.getThreadAccess(groupID, accountID);
        return group && !group.isDM && !group.hidden ? group : null;
    }
    function command(accountID, text) {
        if (/^list_joined_groups$/i.test(text.trim())) {
            threadUtils.expireThreadRequests();
            const groups = db.prepare(`SELECT t.threadID, t.title FROM threads t JOIN thread_members m ON m.threadID = t.threadID
                WHERE t.isDM = 0 AND m.accountID = ? AND m.status = 1 AND m.hidden = 0 ORDER BY t.threadID`).all(accountID);
            return groups.map(group => `${group.threadID} - ${group.title}`).join('\n') || 'No joined groups.';
        }
        const match = /^(accept_group|deny_group|list_group_members|report_group|leave_group)\s+([1-9]\d*)$/i.exec(text.trim());
        if (!match) return null;
        threadUtils.expireThreadRequests();
        const groupID = Number(match[2]);
        const group = access(accountID, groupID);
        if (!group) return false;
        const name = match[1].toLowerCase();
        if (name === 'list_group_members') {
            if (group.status !== 1) return false;
            const members = db.prepare(`SELECT m.accountID, p.userName FROM thread_members m JOIN profiles p ON p.accountID = m.accountID
                WHERE m.threadID = ? AND m.status = 1 ORDER BY m.joinedAt, m.accountID`).all(groupID);
            return `Group ${groupID}: ${group.title}\n${members.map(member => `${member.accountID} - ${member.userName}`).join('\n')}`;
        }
        if (name === 'report_group') {
            if (![0, 1].includes(group.status)) return false;
            return invoke(report, accountID, { type: '8', targetID: String(groupID), reasons: '0' }) === '1'
                ? `Reported group ${groupID}.` : false;
        }
        const mode = { accept_group: '8', deny_group: '9', leave_group: '5' }[name];
        if (invoke(update, accountID, { threadID: String(groupID), mode }) !== '1') return false;
        return `${name === 'accept_group' ? 'Joined' : name === 'deny_group' ? 'Declined' : 'Left'} group ${groupID}: ${group.title}`;
    }
    function sendLegacy(accountID, groupID, text) {
        threadUtils.expireThreadRequests();
        const group = access(accountID, groupID);
        if (!group || group.status !== 1) return false;
        return /^\d+:\d+$/.test(invoke(send, accountID, { threadID: String(groupID), body: encode(text) }));
    }
    function onMessage(message) {
        const group = db.prepare('SELECT * FROM threads WHERE threadID = ?').get(message.threadID);
        if (!group || group.isDM) return;
        if (message.isSystem) {
            const fields = decode(message.content).split(',');
            if (fields[0] !== '6') return;
            const target = Number(fields[3]);
            const invitation = db.prepare('SELECT status FROM thread_members WHERE threadID = ? AND accountID = ?').get(group.threadID, target);
            if (invitation?.status !== 0) return;
            notify(target, group.title, `Group ${group.threadID}: ${group.title}\n${group.description}\nAccept: accept_group ${group.threadID}\nDecline: deny_group ${group.threadID}\nAfter joining, send a message to GDPSnode Notifications with subject "group ${group.threadID}" to chat.`);
            return;
        }
        const author = db.prepare('SELECT userName FROM profiles WHERE accountID = ?').get(message.accountID)?.userName || 'Player';
        const recipients = db.prepare(`SELECT m.accountID FROM thread_members m JOIN accounts a ON a.accountID = m.accountID
            WHERE m.threadID = ? AND m.status = 1 AND m.hidden = 0 AND m.muted = 0 AND m.accountID != ? AND a.isDisabled = 0`).all(group.threadID, message.accountID);
        for (const recipient of recipients) notify(recipient.accountID, `Group ${group.title}: ${author}`,
            `Group ${group.threadID}: ${group.title}\n${author}: ${decode(message.content)}\nReply with subject "group ${group.threadID}".`);
    }
    return { command, sendLegacy, onMessage };
};
