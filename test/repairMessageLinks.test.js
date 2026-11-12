'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../repairMessageLinks');
const encode = text => Buffer.from(text).toString('base64');

test('repair skips ambiguous copies, repeated content and mismatched content', () => {
    const messages = [
        { ID: 1, subject: encode('Old reply'), body: 'Body', timestamp: 1 },
        { ID: 2, subject: encode('New DM'), body: 'Modern', timestamp: 2 },
        { ID: 3, subject: encode('New DM'), body: 'Ambiguous', timestamp: 3 },
        { ID: 4, subject: encode('New DM'), body: 'Repeated', timestamp: 4 },
        { ID: 5, subject: encode('New DM'), body: 'Repeated', timestamp: 4 },
        { ID: 6, subject: encode('New DM'), body: 'Different', timestamp: 5 }
    ].map(row => ({ accID: 72, toAccountID: 73, ...row }));
    const candidates = new Map([
        [1, [{ messageID: 11, content: encode('Old reply\n\nBody') }]],
        [2, [{ messageID: 12, content: encode('Modern') }]],
        [3, [{ messageID: 13, content: encode('Ambiguous') }, { messageID: 14, content: encode('Ambiguous') }]],
        [4, [{ messageID: 15, content: encode('Repeated') }]],
        [5, [{ messageID: 16, content: encode('Other message') }]]
    ]);
    const recovered = [];
    const db = {
        transaction(fn) { return fn; },
        prepare(sql) {
            return { all(...params) {
                if (sql.startsWith('SELECT m.*')) return messages;
                assert.deepEqual(params.slice(0, 3), [72, 73, 72]);
                return candidates.get(params[3]) || [];
            } };
        }
    };
    repair(db, (messageID, ids) => recovered.push([messageID, ids]), body => body);
    assert.deepEqual(recovered, [[11, [1]], [12, [2]]]);
});
