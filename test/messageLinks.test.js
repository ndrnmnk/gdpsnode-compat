'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('persistent links cascade atomically across all copies with recursive triggers on or off', () => {
    let schema;
    require('../messageLinks')({ exec(sql) { schema = sql; } });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-message-links-'));
    const file = path.join(directory, 'schema.sql');
    fs.writeFileSync(file, schema);
    let result;
    try {
        result = spawnSync('python3', ['-c', `
import sqlite3, sys
schema = open(sys.argv[1]).read()
for recursive in (0, 1):
    db = sqlite3.connect(':memory:')
    db.executescript('''
        CREATE TABLE messages (ID INTEGER PRIMARY KEY);
        CREATE TABLE threads (threadID INTEGER PRIMARY KEY, mv INTEGER DEFAULT 0);
        CREATE TABLE thread_messages (messageID INTEGER PRIMARY KEY, threadID INTEGER);
        INSERT INTO threads (threadID) VALUES (1);
    ''')
    db.executescript(schema)
    db.executescript(schema) # Restart / reinstall must preserve existing links.
    db.execute('PRAGMA recursive_triggers = ' + str(recursive))
    for source in ('messages WHERE ID = 12', 'thread_messages WHERE messageID = 1'):
        db.executescript('''
            INSERT INTO thread_messages VALUES (1, 1), (2, 1);
            INSERT INTO messages VALUES (11), (12), (13), (99);
            INSERT INTO legacy_compat_message_links VALUES (11, 1), (12, 1), (13, 1);
        ''')
        db.execute('DELETE FROM ' + source)
        assert db.execute('SELECT * FROM messages').fetchall() == [(99,)]
        assert db.execute('SELECT * FROM thread_messages').fetchall() == [(2, 1)]
        assert db.execute('SELECT * FROM legacy_compat_message_links').fetchall() == []
        db.rollback()
        assert db.execute('SELECT COUNT(*) FROM messages').fetchone()[0] == 4
        assert db.execute('SELECT COUNT(*) FROM legacy_compat_message_links').fetchone()[0] == 3
        db.execute('DELETE FROM thread_messages WHERE threadID = 1')
        assert db.execute('SELECT COUNT(*) FROM legacy_compat_message_links').fetchone()[0] == 0
        db.execute('DELETE FROM messages')
        db.commit()
`, file], { encoding: 'utf8', timeout: 5000 });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    assert.equal(result.status, 0, result.stderr);
});
