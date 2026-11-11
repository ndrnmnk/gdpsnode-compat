'use strict';

// No npm dependencies needed: exercise the real endpoints against SQLite via Python's stdlib.
// Filesystem operations for level files are redirected to this test's temporary directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-legacy-test-'));
const databaseFile = path.join(temporary, 'test.sqlite');
const python = `import sqlite3,json,sys
r=json.load(open(sys.argv[1]))
c=sqlite3.connect(r['file'])
c.row_factory=sqlite3.Row
if r['method']=='exec':
 c.executescript(r['sql']); result=None
else:
 q=c.execute(r['sql'],r['params'])
 if r['method']=='all': result=[dict(row) for row in q.fetchall()]
 elif r['method']=='get':
  row=q.fetchone(); result=dict(row) if row else None
 else: result={'changes':q.rowcount,'lastInsertRowid':q.lastrowid}
c.commit()
print(json.dumps(result))`;
let hooks;
const statements = [];
function execute(sql, method, params = []) {
    if (process.env.LEGACY_TEST_DEBUG) process.stderr.write(`${method}: ${sql.slice(0, 90)}\n`);
    statements.push(sql);
    const requestFile = path.join(temporary, 'query.json');
    fs.writeFileSync(requestFile, JSON.stringify({ file: databaseFile, sql, method, params }));
    const result = spawnSync('python3', ['-c', python, requestFile], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error(`${result.stderr}\nSQL: ${sql}`);
    return JSON.parse(result.stdout) ?? undefined;
}
const db = {
    exec(sql) { return execute(sql, 'exec'); },
    prepare(sql) {
        const prepared = hooks ? hooks.trigger('database:prepare', { sql }) : { sql };
        return Object.fromEntries(['get', 'all', 'run'].map(method => [method, (...params) => {
            const request = { sql: prepared.sql, method, params, execute: () => execute(prepared.sql, method, request.params) };
            hooks?.trigger('database:query', request);
            return request.handled ? request.result : request.execute();
        }]));
    },
    transaction(fn) {
        return (...args) => {
            const snapshot = path.join(temporary, `snapshot-${crypto.randomUUID()}`);
            fs.copyFileSync(databaseFile, snapshot);
            try { return fn(...args); }
            catch (error) { fs.copyFileSync(snapshot, databaseFile); throw error; }
            finally { fs.unlinkSync(snapshot); }
        };
    }
};
const schema = fs.readFileSync(path.join(root, 'database.js'), 'utf8').split('db.exec(`')[1].split('`);')[0];
db.exec(schema);
const levelFs = {
    ...fs.promises,
    access: async () => {},
    readFile: file => fs.promises.readFile(path.join(temporary, path.basename(file))),
    writeFile: (file, data) => fs.promises.writeFile(path.join(temporary, path.basename(file)), data),
    unlink: file => fs.promises.unlink(path.join(temporary, path.basename(file)))
};
const load = Module._load;
Module._load = function (request, parent, ...args) {
    const resolved = request.startsWith('.') && parent ? path.resolve(path.dirname(parent.filename), request) : request;
    if ([path.join(root, 'database'), path.join(root, 'database.js')].includes(resolved)) return db;
    if (resolved === path.join(root, 'levelSchedule')) return { reconcileLevelSchedule() {} };
    if (resolved === path.join(root, 'webhook.js')) return { infoWebhookEmbed() {} };
    if (request === 'fs/promises' && parent?.filename.startsWith(path.join(root, 'endpoints'))) return levelFs;
    return load.call(this, request, parent, ...args);
};
const utils = require(path.join(root, 'utils'));
const httpsGuardEnabled = !require('../config.js').allow_insecure_login;
const { HookRegistry } = require(path.join(root, 'hooks'));
const layers = [];
const app = {
    use(handler) { layers.push({ handlers: [handler] }); },
    post(route, ...handlers) { layers.push({ route, handlers }); }
};
// GDPSnode normalizes doubled slashes before loading plugin middleware.
app.use((req, res, next) => {
    const queryIndex = req.url.indexOf('?');
    const pathname = queryIndex === -1 ? req.url : req.url.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : req.url.slice(queryIndex);
    req.url = `${pathname.replace(/\/{2,}/g, '/')}${query}`;
    next();
});
hooks = new HookRegistry(app);
hooks.registerPlugin(require('..'), { db, utils, config: {} });
const endpoints = [
    'levels/getGJLevels21', 'levels/downloadGJLevel22', 'levels/uploadGJLevel21',
    'scores/updateGJUserScore22', 'scores/getGJScores20', 'misc/likeGJItem211', 'levels/rateGJStars211',
    'comments/getGJComments21', 'comments/uploadGJComment21', 'comments/deleteGJComment20', 'comments/deleteGJAccComment20',
    'accounts/loginGJAccount', 'accounts/registerGJAccount', 'accounts/syncGJAccountNew', 'accounts/backupGJAccountNew', 'accounts/updateGJAccSettings20',
    'social/uploadFriendRequest20', 'social/getGJFriendRequests20',
    'levels/getGJMapPacks21', 'levels/getGJGauntlets21', 'levels/getGJChallenges', 'levels/deleteGJLevelUser20', 'users/getGJUserInfo20', 'users/getGJUsers20',
    'threads/updateGJThread', 'misc/reportGJContent', 'threads/getGJThreads', 'threads/getGJThreadMessages', 'threads/sendGJThreadMessage', 'messages/getGJMessages20', 'messages/downloadGJMessage20', 'rewards/getGJRewards'
];
for (const name of endpoints) {
    const endpoint = require(path.join(root, 'endpoints', name));
    app.post(endpoint.path, ...(endpoint.middleware || []), endpoint.handler);
}
const newsContent = require(path.join(root, 'newsContent'));
Module._load = load;

function post(url, body, inspect, ip = '127.0.0.1', transport = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Request timed out: ${url}`)), 10000);
        const req = { url, ip, secure: transport.secure === true, headers: transport.headers || {}, method: 'POST', body: { secret: 'Wmfd2893gb7', ...body }, get path() { return this.url.split('?')[0]; } };
        const res = { headersSent: false, type() { return this; }, send(value) { this.headersSent = true; clearTimeout(timer); resolve(String(value)); return this; } };
        const stack = layers.flatMap(layer => layer.handlers.map(handler => ({ route: layer.route, handler })));
        let index = 0;
        function next(error) {
            if (error) { clearTimeout(timer); reject(error); return; }
            try {
                while (index < stack.length) {
                    const layer = stack[index++];
                    if (layer.route && layer.route !== req.path) continue;
                    if (inspect && layer.route) inspect(req);
                    Promise.resolve(layer.handler(req, res, next)).catch(next);
                    return;
                }
                res.send('-1');
            } catch (error) { next(error); }
        }
        next();
    });
}
const enc = value => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const xor = (value, key) => Buffer.from(Array.from(value, (ch, i) => ch.charCodeAt(0) ^ key.charCodeAt(i % key.length)));
const password = 'test-password';
const gjp2 = utils.generateGJP2(password);
const gjp = enc(xor(password, '37526'));
const auth = { accountID: '72', gjp, gameVersion: '21', binaryVersion: '35' };
for (const [id, name] of [[72, 'Alice'], [73, 'Bob'], [74, 'Carol']]) {
    db.prepare('INSERT INTO accounts (accountID, userName, gjp2, isDisabled) VALUES (?, ?, ?, 0)').run(id, name, gjp2);
    db.prepare('INSERT INTO profiles (accountID, userName, mS) VALUES (?, ?, 0)').run(id, name);
}
function fields(text, delimiter = ':') {
    const list = text.split(delimiter);
    return Object.fromEntries(Array.from({ length: Math.floor(list.length / 2) }, (_, i) => list.slice(i * 2, i * 2 + 2)));
}

// Keep this suite sequential: it deliberately shares one fixture database.
test('legacy compatibility against core endpoints and SQLite', async t => {
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    await t.test('password login and GJP are translated; wrong passwords still fail', async () => {
        assert.equal(await post('/accounts/loginGJAccount.php', { userName: 'Alice', password, secret: 'Wmfv3899gc9' }, undefined, undefined, { secure: true }), '72,73');
        assert.equal(await post('/accounts/loginGJAccount.php', { userName: 'Alice', password: 'wrong', secret: 'Wmfv3899gc9' }, undefined, undefined, { secure: true }), '-11');
        assert.equal(await post('/updateGJUserScore21.php', { ...auth, stars: '50' }), '73');
        assert.equal(await post('/updateGJUserScore21.php', { ...auth, gjp: enc(xor('wrong', '37526')) }), '-1');
    });
    await t.test('plaintext login and registration require HTTPS across game versions', {
        skip: !httpsGuardEnabled && 'HTTPS guard is temporarily commented out for client testing'
    }, async () => {
        const login = { userName: 'Alice', password, secret: 'Wmfv3899gc9' };
        const before = statements.length;
        for (const gameVersion of ['19', '20', '21', '22', undefined]) {
            assert.equal(await post('/accounts/loginGJAccount.php', { ...login, gameVersion }), '-1');
            assert.equal(await post('/accounts/registerGJAccount.php', { ...login, userName: 'BlockedUser', rsession: 'session', gameVersion }), '-1');
        }
        // Block before hashing, looking up credentials, or creating accounts.
        assert.equal(statements.length, before);
        assert.equal(await post('/accounts/loginGJAccount.php', { ...login, gjp2, gameVersion: '22' }), '-1');
        assert.equal(await post('//ACCOUNTS/LOGINGJACCOUNT.PHP/', login), '-1');
        assert.equal(await post('/accounts/loginGJAccount.php', login, undefined, undefined, { headers: { 'x-forwarded-proto': 'https' } }), '-1');
        assert.equal(await post('/accounts/loginGJAccount.php', login, undefined, undefined, { secure: true }), '72,73');
        // Hash-based login still follows the original HTTP behavior.
        assert.equal(await post('/accounts/loginGJAccount.php', { userName: 'Alice', gjp2, gameVersion: '22', secret: 'Wmfv3899gc9' }), '72,73');
        const registration = { userName: 'TLSUser', password, secret: 'Wmfv3899gc9', gameVersion: '19' };
        assert.equal(await post('/accounts/registerGJAccount.php', registration, undefined, undefined, { secure: true }), '1');
        const account = db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('TLSUser');
        assert.ok(account);
        db.prepare('DELETE FROM messages WHERE toAccountID = ? OR accID = ?').run(account.accountID, account.accountID);
        db.prepare('DELETE FROM profiles WHERE accountID = ?').run(account.accountID);
        db.prepare('DELETE FROM accounts WHERE accountID = ?').run(account.accountID);
        assert.equal(db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('BlockedUser'), undefined);
    });
    await t.test('old score updates retain newer statistics and icons', async () => {
        db.prepare("UPDATE profiles SET moons = 123, diamonds = 77, accSwing = 9, accSpider = 8, dinfo = '1,2,3', sinfo = '4,5', pinfo = '6' WHERE accountID = 72").run();
        assert.equal(await post('/updateGJUserScore19.php', { ...auth, gameVersion: '19', stars: '42' }), '73');
        const profile = db.prepare('SELECT * FROM profiles WHERE accountID = 72').get();
        assert.equal(profile.stars, 42);
        assert.equal(profile.moons, 123);
        assert.equal(profile.diamonds, 77);
        assert.equal(profile.accSwing, 9);
        assert.equal(profile.accSpider, 8);
        assert.equal(profile.dinfo, '1,2,3');
        assert.equal(profile.sinfo, '4,5');
        assert.equal(profile.pinfo, '6');
    });
    let level18, level19, level22;
    const rawLevel = 'kS38,1;1,1,2,15,3,15;';
    await t.test('1.x raw and 1.9 zlib uploads become valid gzip and download in the original format', async () => {
        level18 = await post('/uploadGJLevel.php', { ...auth, gameVersion: '18', levelName: 'Old Level', levelDesc: 'plain description', levelString: rawLevel });
        assert.match(level18, /^\d+$/);
        assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(temporary, `${level18}.gdcs`))).toString(), rawLevel);
        level19 = await post('/uploadGJLevel19.php', { ...auth, gameVersion: '19', levelName: 'Nineteen', levelDesc: 'plain description', levelString: enc(zlib.deflateSync(rawLevel)) });
        assert.match(level19, /^\d+$/);
        const download = await post('/downloadGJLevel.php', { gameVersion: '18', levelID: level18 });
        assert.equal(fields(download.split('#')[0])['4'], rawLevel);
        assert.equal(fields(download.split('#')[0])['3'], 'plain description');
        assert.equal(fields(download.split('#')[0])['27'], '0');
        const modernEncoding = await post('/downloadGJLevel19.php', { gameVersion: '19', levelID: level19 });
        assert.equal(zlib.unzipSync(Buffer.from(fields(modernEncoding.split('#')[0])['4'], 'base64')).toString(), rawLevel);
        const hash = crypto.createHash('sha1').update(rawLevel + 'xI25fpAapCQg').digest('hex');
        assert.equal(download.split('#')[1], hash);
        assert.equal(await post('/uploadGJLevel19.php', { ...auth, gameVersion: '19', levelName: 'Invalid', levelString: 'broken' }).catch(() => '-1'), '-1');
    });
    await t.test('search counts, pagination and direct downloads exclude newer levels', async () => {
        level22 = db.prepare('INSERT INTO levels (accountID, levelName, levelDesc, audioTrack, password, uploadDate, updateDate, gameVersion) VALUES (72, ?, ?, 0, 1, 0, 0, 22)').run('Modern', '').lastInsertRowid;
        fs.writeFileSync(path.join(temporary, `${level22}.gdcs`), zlib.gzipSync(rawLevel));
        const old = await post('/getGJLevels.php', { gameVersion: '18', type: '4', page: '0' });
        assert.equal(old.split('#').length, 4);
        assert.equal(old.split('#')[2], '1:0:10');
        assert.equal(fields(old.split('#')[0])['1'], level18);
        const nineteen = await post('/getGJLevels19.php', { gameVersion: '19', type: '4', page: '0' });
        assert.equal(nineteen.split('#')[3], '2:0:10');
        assert.equal(await post('/downloadGJLevel19.php', { gameVersion: '19', levelID: String(level22) }), '-1');
        const latest = await post('/getGJLevels21.php', { gameVersion: '22', type: '4', page: '0' });
        assert.equal(latest.split('#')[3], '3:0:10');
    });
    await t.test('legacy comments have plain text and separate users; 2.1 has inline profiles', async () => {
        const id = await post('/uploadGJComment19.php', { ...auth, gameVersion: '19', userName: 'Alice', levelID: level18, comment: 'Nice level' });
        assert.match(id, /^\d+$/);
        const old = await post('/getGJComments19.php', { gameVersion: '19', levelID: level18 });
        assert.equal(fields(old.split('#')[0], '~')['2'], 'Nice level');
        assert.equal(old.split('#')[1], '73:Alice:72');
        const newer = await post('/getGJComments21.php', { gameVersion: '21', binaryVersion: '35', levelID: level18 });
        assert.equal(newer.split('#').length, 2);
        assert.match(newer, /:1~Alice/);
    });
    await t.test('version filters survive OR search filters and cover gauntlets', async () => {
        db.prepare('UPDATE levels SET starEpic = 1 WHERE levelID = ?').run(level22);
        const results = await post('/getGJLevels19.php', { gameVersion: '19', featured: '1', epic: '1' });
        assert.equal(results.split('#')[0], '');
        assert.equal(results.split('#')[3], '0:0:10');
        db.prepare('INSERT INTO gauntlets VALUES (1, ?, ?, ?, ?, ?)').run(level18, level18, level18, level18, level18);
        db.prepare('INSERT INTO gauntlets VALUES (2, ?, ?, ?, ?, ?)').run(level18, level18, level18, level18, level22);
        const old = await post('/getGJGauntlets.php', { gameVersion: '21' });
        assert.equal(old.split('#')[0].split('|').length, 1);
        const latest = await post('/getGJGauntlets21.php', { gameVersion: '22' });
        assert.equal(latest.split('#')[0].split('|').length, 2);
    });
    await t.test('2.0 route suffix infers base64 comments and retains the separate author section', async () => {
        const id = await post('/uploadGJComment20.php', { accountID: '72', gjp, userName: 'Alice', levelID: level19, comment: enc('Two point zero') });
        assert.match(id, /^\d+$/);
        const response = await post('/getGJComments20.php', { levelID: level19 });
        assert.equal(fields(response.split('#')[0], '~')['2'], enc('Two point zero'));
        assert.equal(response.split('#')[1], '73:Alice:72');
    });
    await t.test('device guests get persistent isolated profiles and cannot claim registered user IDs', async () => {
        const body = { gameVersion: '18', udid: 'test-device', userName: 'Guest', stars: '5', userID: '73' };
        const id = await post('/updateGJUserScore.php', body);
        assert.match(id, /^\d+$/);
        assert.notEqual(id, '73');
        assert.equal(await post('/updateGJUserScore.php', body), id);
        assert.equal(db.prepare('SELECT stars FROM profiles WHERE accountID = 72').get().stars, 42);
        assert.equal(await post('/updateGJUserScore.php', { ...body, udid: 'other-device', secret: 'bad' }), '-1');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legacy_compat_guests').get().count, 1);
    });
    await t.test('1.0 likeGJLevel accepts only levelID and persists one vote per IP', async () => {
        const before = db.prepare('SELECT likes FROM levels WHERE levelID = ?').get(level18).likes;
        const body = { levelID: level18, secret: undefined };
        assert.equal(await post('/likeGJLevel.php', body), '1');
        assert.equal(db.prepare('SELECT likes FROM levels WHERE levelID = ?').get(level18).likes, before + 1);
        assert.equal(await post('/likeGJLevel.php', body), '1');
        assert.equal(db.prepare('SELECT likes FROM levels WHERE levelID = ?').get(level18).likes, before + 1);
        assert.equal(await post('/likeGJLevel.php', body, undefined, '127.0.0.2'), '1');
        assert.equal(db.prepare('SELECT likes FROM levels WHERE levelID = ?').get(level18).likes, before + 2);
    });
    await t.test('1.4 likeGJItem persists anonymous level and comment likes/dislikes', async () => {
        const commentID = String(db.prepare('SELECT commentID FROM comments WHERE levelID = ?').get(level18).commentID);
        for (const [type, itemID, table, column] of [['1', level19, 'levels', 'levelID'], ['2', commentID, 'comments', 'commentID']]) {
            const before = db.prepare(`SELECT likes FROM ${table} WHERE ${column} = ?`).get(itemID).likes;
            assert.equal(await post('/likeGJItem.php', { type, itemID, like: '1', secret: undefined }), '1');
            assert.equal(db.prepare(`SELECT likes FROM ${table} WHERE ${column} = ?`).get(itemID).likes, before + 1);
            assert.equal(await post('/likeGJItem.php', { type, itemID, like: '0', secret: undefined }, undefined, '127.0.0.2'), '1');
            assert.equal(db.prepare(`SELECT likes FROM ${table} WHERE ${column} = ?`).get(itemID).likes, before);
        }
        assert.equal(await post('/likeGJItem.php', { type: '2', itemID: commentID, like: '5', secret: undefined }), '-1');
        assert.equal(await post('/likeGJItem.php', { type: '1', itemID: '999999', like: '1', secret: undefined }), '-1');
        assert.equal(await post('/likeGJItem.php', { type: '1', itemID: level18, like: '1', secret: 'wrong' }), '-1');
        assert.equal(await post('/likeGJItem211.php', { gameVersion: '22', type: '1', itemID: level18, secret: undefined }), '-1');
    });
    await t.test('rateGJLevel maps faces including auto/demon to stored star votes without a secret or UDID', async () => {
        for (const [rating, stars] of [['0', 1], ['1', 2], ['2', 3], ['3', 4], ['4', 6], ['5', 8], ['6', 10]]) {
            assert.equal(await post('/rateGJLevel.php', { levelID: level19, rating, secret: undefined }, undefined, `127.0.1.${rating}`), '1');
            const accountID = db.prepare('SELECT accountID FROM legacy_compat_guests WHERE deviceHash = ?').get(crypto.createHash('sha1').update(`legacy-ip:127.0.1.${rating}`).digest('hex')).accountID;
            assert.equal(db.prepare('SELECT stars FROM level_ratings WHERE levelID = ? AND accountID = ?').get(level19, accountID).stars, stars);
        }
        assert.equal(db.prepare('SELECT userRates FROM levels WHERE levelID = ?').get(level19).userRates, 7);
        assert.equal(await post('/rateGJLevel.php', { levelID: level19, rating: '1', secret: undefined }, undefined, '127.0.1.1'), '1');
        assert.equal(db.prepare('SELECT userRates FROM levels WHERE levelID = ?').get(level19).userRates, 7);
        for (const rating of ['-1', '7', '1.5', 'constructor', undefined]) {
            assert.equal(await post('/rateGJLevel.php', { levelID: level19, rating, secret: undefined }), '-1');
        }
    });
    await t.test('getGJScores resolves the original UDID for relative and friends modes', async () => {
        const udid = 'ffffffff-ba31-faa1-0033-c5870033c587';
        const userID = await post('/updateGJUserScore.php', { udid, userName: 'OldPlayer', stars: '15' });
        for (const type of ['top', 'relative', 'friends']) {
            const result = await post('/getGJScores.php', { type, udid });
            assert.notEqual(result, '-1');
            assert.ok(result.split('|').some(row => fields(row)['2'] === userID));
        }
        assert.equal(await post('/getGJScores.php', { type: 'relative', udid, secret: 'wrong' }), '-1');
    });
    await t.test('1.0/1.4 top scores render even when every player has zero stars', async () => {
        const previous = db.prepare('SELECT accountID, stars FROM profiles').all();
        db.prepare('UPDATE profiles SET stars = 0').run();
        try {
            const result = await post('/getGJScores.php', { type: 'top', udid: 'ffffffff-ba31-faa1-0033-c5870033c587' });
            assert.notEqual(result, '-1');
            assert.ok(result.split('|').length >= 2);
            assert.ok(result.split('|').every(row => fields(row)['3'] === '0'));
            assert.equal(await post('/getGJScores20.php', { gameVersion: '22', type: 'top' }), '-1');
        } finally {
            for (const profile of previous) db.prepare('UPDATE profiles SET stars = ? WHERE accountID = ?').run(profile.stars, profile.accountID);
        }
    });
    await t.test('legacy inbox: upload, list without marking read, download marks read, privacy and deletion', async () => {
        const messageBody = { ...auth, toAccountID: '73', subject: enc('Hello'), body: enc(xor('Message body', '14251')) };
        assert.equal(await post('/uploadGJMessage20.php', messageBody), '1');
        const notice = db.prepare('SELECT * FROM notifications WHERE toAccountID = 73 ORDER BY notificationID DESC').get();
        assert.equal(Buffer.from(notice.title, 'base64').toString(), 'New legacy message');
        const id = db.prepare('SELECT ID FROM messages').get().ID;
        const recipient = { ...auth, accountID: '73', page: '0' };
        assert.match(await post('/getGJMessages20.php', recipient), /4:SGVsbG8=/);
        assert.equal(db.prepare('SELECT isNew FROM messages WHERE ID = ?').get(id).isNew, 1);
        const downloaded = await post('/downloadGJMessage20.php', { ...recipient, messageID: String(id) });
        assert.equal(fields(downloaded)['8'], '0');
        assert.equal(db.prepare('SELECT isNew FROM messages WHERE ID = ?').get(id).isNew, 0);
        assert.equal(await post('/downloadGJMessage20.php', { ...auth, accountID: '74', messageID: String(id) }), '-1');
        db.prepare('UPDATE profiles SET mS = 2 WHERE accountID = 73').run();
        assert.equal(await post('/uploadGJMessage20.php', messageBody), '-1');
        assert.equal(await post('/deleteGJMessages20.php', { ...auth, accountID: '74', messageID: String(id) }), '1');
        assert.ok(db.prepare('SELECT ID FROM messages WHERE ID = ?').get(id));
        assert.equal(await post('/deleteGJMessages20.php', { ...recipient, messageID: String(id) }), '1');
        assert.equal(db.prepare('SELECT ID FROM messages WHERE ID = ?').get(id), undefined);
        db.prepare('UPDATE profiles SET mS = 0 WHERE accountID = 73').run();
        assert.equal(await post('/uploadGJMessage20.php', messageBody), '1');
        const latest = { accountID: '73', gjp2, gameVersion: '22', binaryVersion: '47', page: '0' };
        assert.match(await post('/getGJMessages20.php', latest), /8:0/);
        assert.equal(db.prepare('SELECT isNew FROM messages WHERE toAccountID = 73').get().isNew, 0);
    });
    await t.test('backups accept old username/password requests and sync reports the client version', async () => {
        const saveData = `${enc(zlib.gzipSync('<plist><k>GJA_002</k><s>secret</s></plist>'))};${enc(zlib.gzipSync('<plist/>'))}`;
        const body = { userName: 'Alice', password, secret: 'Wmfv3899gc9', gameVersion: '19' };
        assert.equal(await post('/accounts/backupGJAccount.php', { ...body, saveData }), '1');
        const synced = await post('/accounts/syncGJAccount.php', body);
        assert.match(synced, /;19;0;a;a$/);
        assert.match(zlib.gunzipSync(Buffer.from(synced.split(';')[0], 'base64')).toString(), /<s>password<\/s>/);
    });
    await t.test('request contexts remain isolated across asynchronous uploads and modern searches', async () => {
        const results = await Promise.all([
            post('/downloadGJLevel.php', { gameVersion: '18', levelID: level18 }),
            post('/downloadGJLevel22.php', { gameVersion: '22', levelID: String(level22) }),
            post('/getGJLevels19.php', { gameVersion: '19', type: '4' }),
            post('/getGJLevels21.php', { gameVersion: '22', type: '4' })
        ]);
        assert.equal(fields(results[0].split('#')[0])['4'], rawLevel);
        assert.notEqual(fields(results[1].split('#')[0])['4'], rawLevel);
        assert.equal(results[2].split('#')[3], '2:0:10');
        assert.equal(results[3].split('#')[3], '3:0:10');
    });
    await t.test('captured likeGJItem dislikes update existing votes and are visible through modern endpoints', async () => {
        const ip = '::ffff:192.168.50.224';
        db.prepare(`INSERT INTO levels (levelID, accountID, levelName, levelDesc, audioTrack, password, uploadDate, updateDate, gameVersion)
            VALUES (128, 72, 'Captured', '', 0, 1, 0, 0, 18)`).run();
        fs.writeFileSync(path.join(temporary, '128.gdcs'), zlib.gzipSync(rawLevel));
        db.prepare(`INSERT INTO comments (commentID, accountID, userName, comment, levelID, timestamp)
            VALUES (128, 72, 'Alice', ?, 128, 0)`).run(enc('Captured comment'));
        // Reproduce the pre-upgrade database: both items already have a native increment marker.
        assert.equal(await post('/likeGJLevel.php', { levelID: '128', secret: undefined }, undefined, ip), '1');
        const guest = db.prepare(`SELECT a.* FROM legacy_compat_guests g JOIN accounts a ON a.accountID = g.accountID
            WHERE g.deviceHash = ?`).get(crypto.createHash('sha1').update(`legacy-ip:${ip}`).digest('hex'));
        const modern = { accountID: String(guest.accountID), gjp2: guest.gjp2, gameVersion: '22' };
        assert.equal(await post('/likeGJItem211.php', { ...modern, itemID: '128', like: '1', type: '2' }), '1');
        for (const [type, table, column] of [['1', 'levels', 'levelID'], ['2', 'comments', 'commentID']]) {
            assert.equal(db.prepare(`SELECT likes FROM ${table} WHERE ${column} = 128`).get().likes, 1);
            // These are the exact captured form fields and double-slash path.
            const captured = { secret: 'Wmfd2893gb7', itemID: '128', like: '0', type };
            assert.equal(await post('//likeGJItem.php', captured, undefined, ip), '1');
            assert.equal(db.prepare(`SELECT likes FROM ${table} WHERE ${column} = 128`).get().likes, 0);
            if (type === '1') {
                const downloaded = await post('/downloadGJLevel22.php', { gameVersion: '22', levelID: '128' });
                assert.equal(fields(downloaded.split('#')[0])['14'], '0');
            } else {
                const comments = await post('/getGJComments21.php', { gameVersion: '22', levelID: '128' });
                assert.equal(fields(comments.split('#')[0].split(':')[0], '~')['4'], '0');
            }
            assert.equal(await post('//likeGJItem.php', captured, undefined, ip), '1');
            assert.equal(db.prepare(`SELECT likes FROM ${table} WHERE ${column} = 128`).get().likes, -1);
            // The historic marker plus two accepted actions exhaust the PHP reference's three-vote allowance.
            assert.equal(await post('//likeGJItem.php', { ...captured, like: '1' }, undefined, ip), '-1');
            assert.equal(db.prepare(`SELECT likes FROM ${table} WHERE ${column} = 128`).get().likes, -1);
            // Core endpoints retain their own idempotent one-vote policy.
            assert.equal(await post('/likeGJItem211.php', { ...modern, itemID: '128', like: '1', type }), '1');
            assert.equal(db.prepare(`SELECT likes FROM ${table} WHERE ${column} = 128`).get().likes, -1);
        }
    });
    await t.test('anonymous item votes enforce their quota and keep comment spam state in sync', async () => {
        const ip = '192.0.2.1';
        const body = { type: '2', itemID: '128', like: '0' };
        for (let i = 0; i < 3; i++) assert.equal(await post('/likeGJItem.php', body, undefined, ip), '1');
        assert.deepEqual(db.prepare('SELECT likes, isSpam FROM comments WHERE commentID = 128').get(), { likes: -4, isSpam: 1 });
        assert.equal(await post('/likeGJItem.php', body, undefined, ip), '-1');
        assert.equal(await post('/likeGJItem.php', { ...body, like: '1' }, undefined, '192.0.2.2'), '1');
        assert.deepEqual(db.prepare('SELECT likes, isSpam FROM comments WHERE commentID = 128').get(), { likes: -3, isSpam: 0 });
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legacy_compat_like_counts WHERE itemID = 999999').get().count, 0);
    });
    await t.test('captured 1.9 rateGJStars request stores direct 1-10 star votes', async () => {
        db.prepare(`INSERT INTO levels (levelID, accountID, levelName, levelDesc, audioTrack, password, uploadDate, updateDate, gameVersion)
            VALUES (129, 72, 'One Nine', '', 0, 1, 0, 0, 19)`).run();
        const ip = '::ffff:192.168.50.22';
        const captured = { levelID: '129', rating: '10', secret: 'Wmfd2893gb7' };
        assert.equal(await post('//rateGJStars.php', captured, undefined, ip), '1');
        assert.deepEqual(db.prepare('SELECT userRates, avgUserRate, starDifficulty, starStars FROM levels WHERE levelID = 129').get(),
            { userRates: 1, avgUserRate: 10, starDifficulty: 5, starStars: 0 });
        assert.equal(await post('//rateGJStars.php', captured, undefined, ip), '1');
        assert.equal(db.prepare('SELECT userRates FROM levels WHERE levelID = 129').get().userRates, 1);
        for (let rating = 1; rating <= 10; rating++) {
            const clientIP = `192.0.2.${20 + rating}`;
            assert.equal(await post('/rateGJStars.php', { ...captured, rating: String(rating), gameVersion: '19' }, undefined, clientIP), '1');
            const guest = db.prepare('SELECT accountID FROM legacy_compat_guests WHERE deviceHash = ?').get(crypto.createHash('sha1').update(`legacy-ip:${clientIP}`).digest('hex'));
            assert.equal(db.prepare('SELECT stars FROM level_ratings WHERE levelID = 129 AND accountID = ?').get(guest.accountID).stars, rating);
        }
        const before = db.prepare('SELECT userRates FROM levels WHERE levelID = 129').get().userRates;
        for (const rating of ['0', '11', '1.5', '-1', undefined]) {
            assert.equal(await post('/rateGJStars.php', { ...captured, rating }), '-1');
        }
        assert.equal(await post('/rateGJStars.php', { ...captured, secret: 'bad' }), '-1');
        assert.equal(await post('/rateGJStars.php', { ...captured, secret: undefined }), '-1');
        assert.equal(await post('/rateGJStars.php', { ...captured, levelID: '999999' }), '-1');
        assert.equal(await post('/rateGJStars211.php', { levelID: '129', stars: '10', gameVersion: '22' }), '-1');
        assert.equal(db.prepare('SELECT userRates FROM levels WHERE levelID = 129').get().userRates, before);
    });
    await t.test('captured 2.01 anonymous likes and rates update native counters', async () => {
        const ip = '::ffff:192.168.50.22';
        const before = db.prepare('SELECT likes FROM levels WHERE levelID = 128').get().likes;
        assert.equal(await post('//likeGJItem20.php', { itemID: '128', like: '1', type: '1', secret: 'Wmfd2893gb7' }, undefined, ip), '1');
        assert.equal(db.prepare('SELECT likes FROM levels WHERE levelID = 128').get().likes, before + 1);
        assert.equal(await post('//rateGJStars20.php', { gameVersion: '20', binaryVersion: '29', levelID: '128', stars: '8', secret: 'Wmfd2893gb7' }, undefined, ip), '1');
        const guest = db.prepare('SELECT accountID FROM legacy_compat_guests WHERE deviceHash = ?').get(crypto.createHash('sha1').update(`legacy-ip:${ip}`).digest('hex'));
        assert.equal(db.prepare('SELECT stars FROM level_ratings WHERE levelID = 128 AND accountID = ?').get(guest.accountID).stars, 8);
        assert.equal(await post('//likeGJItem20.php', { itemID: '128', like: '1', type: '1', secret: 'bad' }, undefined, ip), '-1');
        assert.equal(await post('//rateGJStars20.php', { gameVersion: '20', binaryVersion: '29', levelID: '128', stars: '8', secret: undefined }, undefined, ip), '-1');
        const commentBefore = db.prepare('SELECT likes FROM comments WHERE commentID = 128').get().likes;
        assert.equal(await post('//likeGJItem20.php', { itemID: '128', like: '1', type: '2' }, undefined, ip), '1');
        assert.equal(db.prepare('SELECT likes FROM comments WHERE commentID = 128').get().likes, commentBefore + 1);
    });
    await t.test('captured 2.01 comment publishes with a generated checksum and base64 text', async () => {
        const body = { gameVersion: '20', binaryVersion: '29', udid: 'ffffffff-bc90-02e8-0033-c5870033c587', userName: 'Player', comment: 'aGU=', secret: 'Wmfd2893gb7', levelID: '128' };
        const id = await post('//uploadGJComment20.php', body);
        assert.match(id, /^\d+$/);
        assert.equal(db.prepare('SELECT comment FROM comments WHERE commentID = ?').get(id).comment, 'aGU=');
        const response = await post('/getGJComments20.php', { gameVersion: '20', binaryVersion: '29', levelID: '128' });
        assert.ok(response.split('#')[0].split('|').some(row => fields(row, '~')['2'] === 'aGU='));
        assert.equal(response.split('#').length, 3);
    });
    await t.test('2.01 uploads store version 20, remain downloadable, and update the same name', async () => {
        const raw = 'kS38,1;1,1240,2,225,3,75;';
        // The capture abbreviates levelString; use a complete gzip payload with its other form fields.
        const body = { gameVersion: '20', binaryVersion: '29', udid: 'ffffffff-bc90-02e8-0033-c5870033c587', userName: 'Player',
            levelID: '0', levelName: 'Unnamed 0', levelDesc: '', levelVersion: '1', levelLength: '0', audioTrack: '0', auto: '0',
            password: '1003971', original: '0', twoPlayer: '0', songID: '0', objects: '1', coins: '0', requestedStars: '10',
            extraString: '29_29_29_40_29_29_29_29_29_29_29_29_29_29_29_29', seed: 'QReSWJACVS',
            seed2: 'BVVXBwUEBFNSAQIHBg8BUAdUBwcGCAQFUQQBAQ5QUgBTAAZSCFcHAw==', levelString: enc(zlib.gzipSync(raw)),
            levelInfo: 'H4sIAAAAAAAAAzPQMze3NrQ20LOwtDawNtQzMwVSAB032OsVAAAA', secret: 'Wmfd2893gb7' };
        const id = await post('//uploadGJLevel21.php', body);
        assert.match(id, /^\d+$/);
        assert.equal(db.prepare('SELECT gameVersion FROM levels WHERE levelID = ?').get(id).gameVersion, 20);
        const found = await post('/getGJLevels20.php', { gameVersion: '20', binaryVersion: '29', str: id });
        assert.equal(fields(found.split('#')[0])['13'], '20');
        const downloaded = await post('/downloadGJLevel20.php', { gameVersion: '20', binaryVersion: '29', levelID: id });
        assert.equal(fields(downloaded.split('#')[0])['13'], '20');
        assert.equal(zlib.gunzipSync(Buffer.from(fields(downloaded.split('#')[0])['4'], 'base64')).toString(), raw);
        // Simulate the version tag left behind by the earlier plugin, then re-upload.
        db.prepare('UPDATE levels SET gameVersion = 21 WHERE levelID = ?').run(id);
        const count = db.prepare('SELECT COUNT(*) AS count FROM levels').get().count;
        const updatedRaw = 'kS38,1;1,1240,2,255,3,75;';
        assert.equal(await post('//uploadGJLevel21.php', { ...body, levelString: enc(zlib.gzipSync(updatedRaw)) }), id);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM levels').get().count, count);
        assert.deepEqual(db.prepare('SELECT gameVersion, levelVersion FROM levels WHERE levelID = ?').get(id), { gameVersion: 20, levelVersion: 2 });
        assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(temporary, `${id}.gdcs`))).toString(), updatedRaw);
        const newID = await post('//uploadGJLevel21.php', { ...body, levelName: 'Different Level' });
        assert.notEqual(newID, id);
        assert.equal(db.prepare('SELECT gameVersion FROM levels WHERE levelID = ?').get(newID).gameVersion, 20);
        // Preserve World/2.1 detection without promoting binary 29.
        const worldID = await post('//uploadGJLevel21.php', { ...body, levelName: 'World Level', binaryVersion: '30' });
        assert.equal(db.prepare('SELECT gameVersion FROM levels WHERE levelID = ?').get(worldID).gameVersion, 21);
        assert.equal(await post('/downloadGJLevel20.php', { gameVersion: '20', binaryVersion: '29', levelID: worldID }), '-1');
    });
    await t.test('2.1 unsigned likes and rates work on current endpoint names with placeholder credentials', async () => {
        const client = { gameVersion: '20', binaryVersion: '34', gdw: '0', accountID: '0', gjp: '0', gjp2: '0',
            udid: 'anonymous-21-voter', uuid: '0', secret: 'Wmfd2893gb7' };
        const before = db.prepare('SELECT likes FROM levels WHERE levelID = 128').get().likes;
        assert.equal(await post('//likeGJItem211.php', { ...client, itemID: '128', type: '1', like: '1' }), '1');
        assert.equal(db.prepare('SELECT likes FROM levels WHERE levelID = 128').get().likes, before + 1);
        assert.equal(await post('//likeGJItem211.php', { ...client, itemID: '128', type: '1', like: '0' }), '1');
        assert.equal(db.prepare('SELECT likes FROM levels WHERE levelID = 128').get().likes, before);
        assert.equal(await post('//rateGJStars211.php', { ...client, levelID: '128', stars: '7' }), '1');
        const guest = db.prepare('SELECT accountID FROM legacy_compat_guests WHERE deviceHash = ?')
            .get(crypto.createHash('sha1').update(client.udid).digest('hex'));
        assert.equal(db.prepare('SELECT stars FROM level_ratings WHERE levelID = 128 AND accountID = ?').get(guest.accountID).stars, 7);
        assert.equal(await post('//rateGJStars211.php', { ...client, levelID: '128', stars: '7', secret: 'bad' }), '-1');
        // Unsigned requests without device IDs use the same IP fallback as older votes.
        assert.equal(await post('/likeGJItem211.php', { gameVersion: '21', type: '2', itemID: '128', like: '1' }, undefined, '192.0.2.99'), '1');
        assert.equal(await post('/rateGJStars211.php', { gameVersion: '21', levelID: '128', stars: '5' }, undefined, '192.0.2.99'), '1');
        assert.equal(await post('/likeGJItem211.php', { gameVersion: '22', type: '2', itemID: '128', like: '1' }), '-1');
        assert.equal(await post('/rateGJStars211.php', { gameVersion: '22', levelID: '128', stars: '5' }), '-1');
    });
    await t.test('2.1 guest uploads accept account zero and placeholder GJP without becoming registered users', async () => {
        const raw = 'kS38,1;1,1,2,450,3,15;';
        const upload = { gameVersion: '20', binaryVersion: '34', gdw: '0', accountID: '0', gjp: '0', gjp2: '',
            udid: 'anonymous-21-uploader', uuid: '0', userName: 'Player', levelID: '0', levelName: 'Anonymous TwentyOne',
            levelDesc: '', levelString: enc(zlib.gzipSync(raw)), password: '', secret: 'Wmfd2893gb7' };
        const id = await post('//uploadGJLevel21.php', upload);
        assert.match(id, /^\d+$/);
        const level = db.prepare('SELECT accountID, gameVersion FROM levels WHERE levelID = ?').get(id);
        assert.notEqual(level.accountID, 72);
        assert.equal(level.gameVersion, 21);
        assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(temporary, `${id}.gdcs`))).toString(), raw);
        const response = await post('/downloadGJLevel21.php', { gameVersion: '20', binaryVersion: '34', levelID: id });
        assert.equal(fields(response.split('#')[0])['13'], '21');
        assert.equal(await post('//uploadGJLevel21.php', upload), id);
        // A positive account ID with bad credentials must never fall back to that guest.
        assert.equal(await post('//uploadGJLevel21.php', { ...upload, accountID: '72', gjp: enc(xor('wrong', '37526')) }), '-1');
    });
    await t.test('captured signed-in 2.1 comment dislike changes the counter despite an existing native vote', async () => {
        // Credential value is replaced with the test account's GJP; other captured form fields are preserved.
        const captured = { gameVersion: '20', binaryVersion: '34', gdw: '0', accountID: '72', gjp,
            udid: 'ffffffff-bc90-02e8-0033-c5870033c587', uuid: '73', itemID: '1', like: '0', type: '2',
            secret: 'Wmfd2893gb7', special: '128', rs: 'PJ78mLCNkr', chk: 'UQwBDQFWCAMLAQIIBVkIUFsGXQNQDQNbUgZcAgEJBlsDAVcFWwZcUw==' };
        db.prepare("UPDATE comments SET accountID = 73, userName = 'Bob' WHERE commentID = 1").run();
        const modern = { accountID: '72', gjp2, gameVersion: '22', itemID: '1', type: '2', like: '1' };
        assert.equal(await post('/likeGJItem211.php', modern), '1');
        const before = db.prepare('SELECT likes FROM comments WHERE commentID = 1').get().likes;
        assert.equal(await post('//likeGJItem211.php', captured), '1');
        assert.equal(db.prepare('SELECT likes FROM comments WHERE commentID = 1').get().likes, before - 1);
        const shown = await post('/getGJComments21.php', { gameVersion: '22', levelID: level18 });
        const comment = shown.split('#')[0].split('|').map(row => fields(row.split(':')[0], '~')).find(row => row['6'] === '1');
        assert.equal(Number(comment['4']), before - 1);
        assert.equal(await post('//likeGJItem211.php', { ...captured, gjp: enc(xor('wrong', '37526')) }), '-1');
        assert.equal(db.prepare('SELECT likes FROM comments WHERE commentID = 1').get().likes, before - 1);
        assert.equal(await post('//likeGJItem211.php', captured), '1');
        assert.equal(await post('//likeGJItem211.php', captured), '-1');
        const after = db.prepare('SELECT likes FROM comments WHERE commentID = 1').get().likes;
        assert.equal(after, before - 2);
        assert.equal(await post('/likeGJItem211.php', modern), '1');
        assert.equal(db.prepare('SELECT likes FROM comments WHERE commentID = 1').get().likes, after);
    });
    await t.test('captured gauntlet level lookup returns exactly five ordered tagged levels and a matching hash', async () => {
        const ids = [204, 201, 205, 202, 203];
        for (let i = 201; i <= 205; i++) {
            db.prepare(`INSERT INTO levels (levelID, accountID, levelName, levelDesc, audioTrack, password, uploadDate, updateDate,
                gameVersion, likes, starStars, starCoins) VALUES (?, 72, ?, '', 0, 1, 0, 0, 21, ?, ?, 1)`)
                .run(i, `Gauntlet ${i}`, 1000 - i, i - 199);
            fs.writeFileSync(path.join(temporary, `${i}.gdcs`), zlib.gzipSync(rawLevel));
        }
        db.prepare('UPDATE gauntlets SET level1 = ?, level2 = ?, level3 = ?, level4 = ?, level5 = ? WHERE ID = 1').run(...ids);
        const captured = { gameVersion: '21', binaryVersion: '34', gdw: '0', gauntlet: '1', secret: 'Wmfd2893gb7' };
        for (const credentials of [{}, { accountID: '72', gjp }]) {
            const response = await post('//getGJLevels21.php', { ...captured, ...credentials });
            const sections = response.split('#');
            assert.equal(sections.length, 5);
            const rows = sections[0].split('|').map(row => fields(row));
            assert.deepEqual(rows.map(row => Number(row['1'])), ids);
            assert.ok(rows.every(row => row['44'] === '1'));
            assert.equal(sections[3], '5:0:10');
            const hashInput = rows.map(row => row['1'][0] + row['1'].at(-1) + row['18'] + row['38']).join('');
            assert.equal(sections[4], crypto.createHash('sha1').update(hashInput + 'xI25fpAapCQg').digest('hex'));
            for (const id of ids) {
                const downloaded = await post('/downloadGJLevel21.php', { gameVersion: '21', binaryVersion: '34', levelID: String(id), ...credentials });
                assert.equal(fields(downloaded.split('#')[0])['1'], String(id));
                assert.equal(fields(downloaded.split('#')[0])['13'], '21');
            }
        }
        const paged = await post('/getGJLevels21.php', { ...captured, page: '999' });
        assert.equal(paged.split('#')[3], '5:0:10');
    });
    await t.test('gauntlet lookups reject unknown, incomplete, private, disabled and newer content', async () => {
        const request = { gameVersion: '21', binaryVersion: '34', gauntlet: '1' };
        for (const gauntlet of ['999', '-1', '1,2']) assert.equal(await post('/getGJLevels21.php', { ...request, gauntlet }), '-1');
        assert.equal(await post('/getGJLevels21.php', { ...request, secret: 'bad' }), '-1');
        assert.equal(await post('/getGJLevels21.php', { ...request, accountID: '72', gjp: enc(xor('wrong', '37526')) }), '-1');
        for (const [column, value, restored] of [['gameVersion', 22, 21], ['unlisted', 1, 0], ['levelLength', 5, 0]]) {
            db.prepare(`UPDATE levels SET ${column} = ? WHERE levelID = 205`).run(value);
            assert.equal(await post('/getGJLevels21.php', request), '-1');
            db.prepare(`UPDATE levels SET ${column} = ? WHERE levelID = 205`).run(restored);
        }
        db.prepare('UPDATE accounts SET isDisabled = 1 WHERE accountID = 72').run();
        assert.equal(await post('/getGJLevels21.php', request), '-1');
        db.prepare('UPDATE accounts SET isDisabled = 0 WHERE accountID = 72').run();
        db.prepare('UPDATE gauntlets SET level5 = 999999 WHERE ID = 1').run();
        assert.equal(await post('/getGJLevels21.php', request), '-1');
        db.prepare('UPDATE gauntlets SET level5 = 203 WHERE ID = 1').run();
    });
    const rewardRequest = { gameVersion: '20', binaryVersion: '34', gdw: '0', accountID: '0', gjp: '',
        udid: 'ffffffff-bc90-02e8-0033-c5870033c587', uuid: '1', rewardType: '0', secret: 'Wmfd2893gb7', chk: 'ia5P8AwgACQA=' };
    function rewardFields(wire, prefix = 'SaKuJ') {
        assert.ok(wire.startsWith(prefix));
        const [encoded, checksum] = wire.slice(5).split('|');
        assert.equal(checksum, crypto.createHash('sha1').update(encoded + 'pC26fpYaQCtg').digest('hex'));
        const parts = utils.xorCipher(Buffer.from(encoded, 'base64'), '59182').toString().split(':');
        assert.equal(parts.length, 12);
        return parts;
    }
    await t.test('captured logged-out daily reward request returns a real guest player ID and account zero', async () => {
        const parts = rewardFields(await post('//getGJRewards.php', rewardRequest));
        const guest = db.prepare('SELECT accountID FROM legacy_compat_guests WHERE deviceHash = ?')
            .get(crypto.createHash('sha1').update(rewardRequest.udid).digest('hex'));
        assert.equal(parts[0], '1');
        assert.equal(parts[1], String(guest.accountID + 1));
        assert.notEqual(parts[1], '0');
        assert.equal(parts[2], utils.xorCipher(Buffer.from(rewardRequest.chk.slice(5), 'base64'), '59182').toString());
        assert.equal(parts[3], rewardRequest.udid);
        assert.equal(parts[4], '0');
        assert.equal(parts[11], '0');
        assert.equal(parts[7], '0');
        assert.equal(parts[10], '0');
        for (const index of [6, 9]) assert.ok(parts[index].split(',').length === 4);
    });
    await t.test('logged-out chests persist counters and cooldowns per device without trusting UUID', async () => {
        const chest1 = rewardFields(await post('/getGJRewards.php', { ...rewardRequest, rewardType: '1' }));
        assert.equal(chest1[7], '1');
        assert.ok(Number(chest1[5]) > 0);
        assert.equal(chest1[11], '1');
        assert.equal(await post('/getGJRewards.php', { ...rewardRequest, rewardType: '1' }), '-1');
        const polled = rewardFields(await post('/getGJRewards.php', { ...rewardRequest, uuid: '73', gjp2 }));
        assert.equal(polled[1], chest1[1]);
        assert.equal(polled[4], '0');
        assert.equal(polled[7], '1');
        assert.ok(Number(polled[5]) > 0);
        assert.equal(db.prepare('SELECT chest1count FROM profiles WHERE accountID = 72').get().chest1count, 0);
        const chest2 = rewardFields(await post('/getGJRewards.php', { ...rewardRequest, rewardType: '2' }));
        assert.equal(chest2[10], '1');
        assert.equal(chest2[7], '1');
        assert.ok(Number(chest2[8]) > 0);
        const other = rewardFields(await post('/getGJRewards.php', { ...rewardRequest, udid: 'another-reward-device', rewardType: '1' }));
        assert.notEqual(other[1], chest1[1]);
        assert.equal(other[7], '1');
        const guestID = Number(chest1[1]) - 1;
        const wait = require(path.join(root, 'config')).rewards.chest1.wait;
        db.prepare('UPDATE profiles SET chest1time = ? WHERE accountID = ?').run(Math.floor(Date.now() / 1000) + 100 - wait - 1, guestID);
        assert.equal(rewardFields(await post('/getGJRewards.php', { ...rewardRequest, rewardType: '1' }))[7], '2');
    });
    await t.test('legacy reward handling preserves signed-in and modern responses and rejects invalid guests', async () => {
        const signed = rewardFields(await post('/getGJRewards.php', { ...rewardRequest, accountID: '72', gjp }), 'PrStn');
        assert.equal(signed[4], '72');
        const modern = rewardFields(await post('/getGJRewards.php', { ...rewardRequest, gameVersion: '22', accountID: '72', gjp: undefined, gjp2 }), 'PrStn');
        assert.equal(modern[4], '72');
        const before = db.prepare('SELECT COUNT(*) AS count FROM legacy_compat_guests').get().count;
        for (const invalid of [{ udid: '' }, { udid: '123' }, { udid: 'invalid:device' }, { chk: '' }, { chk: 'ABCDE!!!!' }, { secret: 'bad' }, { rewardType: '3' }]) {
            assert.equal(await post('/getGJRewards.php', { ...rewardRequest, ...invalid }), '-1');
        }
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legacy_compat_guests').get().count, before);
        assert.equal(await post('/getGJRewards.php', { ...rewardRequest, accountID: '72', gjp: enc(xor('wrong', '37526')) }), '-1');
        const guest = db.prepare('SELECT accountID FROM legacy_compat_guests WHERE deviceHash = ?')
            .get(crypto.createHash('sha1').update(rewardRequest.udid).digest('hex'));
        db.prepare('UPDATE accounts SET isDisabled = 1 WHERE accountID = ?').run(guest.accountID);
        assert.equal(await post('/getGJRewards.php', rewardRequest), '-1');
        db.prepare('UPDATE accounts SET isDisabled = 0 WHERE accountID = ?').run(guest.accountID);
    });
    const namedGuest = { udid: 'named-guest-device', accountID: '0', userName: 'Green_Name', gameVersion: '20', binaryVersion: '29' };
    let namedLevelID;
    let namedCommentID;
    let namedGuestID;
    await t.test('guest display names remain public while internal credentials and registered identities stay separate', async () => {
        namedGuestID = await post('/updateGJUserScore20.php', { ...namedGuest, stars: '15' });
        namedLevelID = await post('/uploadGJLevel21.php', { ...namedGuest, levelID: '0', levelName: 'Named Guest Level', levelString: enc(zlib.gzipSync(rawLevel)) });
        assert.match(namedLevelID, /^\d+$/);
        namedCommentID = await post('/uploadGJComment20.php', { ...namedGuest, levelID: namedLevelID, comment: enc('Guest comment') });
        assert.match(namedCommentID, /^\d+$/);
        for (const version of ['19', '20', '21', '22']) {
            const binaryVersion = version === '19' ? '0' : version === '20' ? '29' : version === '21' ? '34' : '47';
            if (version !== '19') {
                const levels = await post('/getGJLevels21.php', { gameVersion: version, binaryVersion, str: namedLevelID });
                assert.ok(levels.split('#')[1].includes(`${namedGuestID}:Green_Name:0`));
                assert.ok(!levels.includes('_legacy_'));
            }
            const comments = await post('/getGJComments21.php', { gameVersion: version, binaryVersion, levelID: namedLevelID });
            if (version === '19' || version === '20') assert.equal(comments.split('#')[1], `${namedGuestID}:Green_Name:0`);
            else {
                const profile = fields(comments.split('#')[0].split(':')[1], '~');
                assert.equal(profile['1'], 'Green_Name');
                assert.equal(profile['16'], '0');
            }
        }
        const publicProfile = fields((await post('/getGJUsers20.php', { gameVersion: '22', str: namedGuestID })).split('#')[0]);
        assert.equal(publicProfile['1'], 'Green_Name');
        assert.equal(publicProfile['2'], namedGuestID);
        assert.equal(publicProfile['16'], '0');
        const scores = await post('/getGJScores20.php', { gameVersion: '22', type: 'top' });
        const guestScore = scores.split('|').map(row => fields(row)).find(row => row['2'] === namedGuestID);
        assert.equal(guestScore['16'], '0');
        assert.equal(guestScore['7'], '0');
        const stored = db.prepare('SELECT userName FROM accounts WHERE accountID = ?').get(Number(namedGuestID) - 1);
        assert.match(stored.userName, /^_legacy_/);
        assert.equal(db.prepare('SELECT userName FROM accounts WHERE accountID = 72').get().userName, 'Alice');
    });
    await t.test('later guest names update existing authors and valid 2.1 guest comment checksums still work', async () => {
        await post('/updateGJUserScore20.php', { ...namedGuest, userName: 'Renamed_Guest' });
        const comment = enc('Twenty one guest');
        const chk = enc(xor(crypto.createHash('sha1').update(`Renamed_Guest${comment}${namedLevelID}00xPT6iUrtws0J`).digest('hex'), '29481'));
        const id = await post('/uploadGJComment21.php', { ...namedGuest, userName: 'Renamed_Guest', binaryVersion: '34', gjp: '0', levelID: namedLevelID, comment, percent: '0', chk });
        assert.match(id, /^\d+$/);
        assert.equal(await post('/uploadGJComment21.php', { ...namedGuest, userName: 'Renamed_Guest', binaryVersion: '34', levelID: namedLevelID, comment, chk: 'bad' }), '-1');
        const shown = await post('/getGJComments21.php', { gameVersion: '22', levelID: namedLevelID });
        for (const row of shown.split('#')[0].split('|')) {
            const profile = fields(row.split(':')[1], '~');
            assert.equal(profile['1'], 'Renamed_Guest');
            assert.equal(profile['16'], '0');
        }
        db.prepare('UPDATE levels SET dailyNumber = 90000, dailyTime = ? WHERE levelID = ?').run(Math.floor(Date.now() / 1000) + 3600, namedLevelID);
        const daily = await post('/downloadGJLevel22.php', { gameVersion: '22', levelID: '-1' });
        assert.equal(daily.split('#')[3], `${namedGuestID}:Renamed_Guest:0`);
        db.prepare('UPDATE levels SET dailyNumber = 0, dailyTime = 0 WHERE levelID = ?').run(namedLevelID);
    });
    await t.test('captured anonymous comment deletion resolves the author UDID and enforces ownership', async () => {
        const request = { udid: namedGuest.udid, accountID: '0', commentID: namedCommentID, levelID: namedLevelID, secret: 'Wmfd2893gb7' };
        assert.equal(await post('//deleteGJComment19.php', { ...request, udid: 'anonymous-21-uploader' }), '-1');
        assert.ok(db.prepare('SELECT commentID FROM comments WHERE commentID = ?').get(namedCommentID));
        assert.equal(await post('//deleteGJComment19.php', { ...request, secret: 'bad' }), '-1');
        assert.equal(await post('//deleteGJComment19.php', request), '1');
        assert.equal(db.prepare('SELECT commentID FROM comments WHERE commentID = ?').get(namedCommentID), undefined);
        for (const [version, binaryVersion] of [['20', '29'], ['20', '34']]) {
            const info = db.prepare("INSERT INTO comments (accountID, userName, comment, levelID, timestamp) VALUES (?, 'Guest', ?, ?, 0)")
                .run(Number(namedGuestID) - 1, enc('Delete again'), namedLevelID);
            assert.equal(await post('/deleteGJComment20.php', { ...request, gameVersion: version, binaryVersion, commentID: String(info.lastInsertRowid) }), '1');
        }
        const before = db.prepare('SELECT COUNT(*) AS count FROM legacy_compat_guests').get().count;
        assert.equal(await post('/deleteGJComment19.php', { ...request, udid: 'unseen-delete-device' }), '-1');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legacy_compat_guests').get().count, before);
    });
    await t.test('captured anonymous level deletion works across 1.9/2.0/2.1 with the level secret and native cleanup', async () => {
        for (const [route, version, binaryVersion] of [['deleteGJLevelUser19', '19', '0'], ['deleteGJLevelUser20', '20', '29'], ['deleteGJLevelUser20', '20', '34']]) {
            const id = await post('/uploadGJLevel21.php', { ...namedGuest, gameVersion: version, binaryVersion, levelName: `Delete ${version} ${binaryVersion}`, levelString: enc(zlib.gzipSync(rawLevel)) });
            assert.match(id, /^\d+$/);
            const request = { udid: namedGuest.udid, accountID: '0', levelID: id, secret: 'Wmfv2898gc9', gameVersion: version, binaryVersion };
            assert.equal(await post(`//${route}.php`, { ...request, udid: 'anonymous-21-uploader' }), '-1');
            assert.equal(await post(`//${route}.php`, { ...request, secret: 'Wmfd2893gb7' }), '-1');
            db.prepare('UPDATE levels SET starStars = 2 WHERE levelID = ?').run(id);
            assert.equal(await post(`//${route}.php`, request), '-1');
            db.prepare('UPDATE levels SET starStars = 0 WHERE levelID = ?').run(id);
            db.prepare("INSERT INTO comments (accountID, userName, comment, levelID, timestamp) VALUES (73, 'Bob', ?, ?, 0)").run(enc('Cleanup'), id);
            assert.equal(await post(`//${route}.php`, request), '1');
            assert.equal(db.prepare('SELECT levelID FROM levels WHERE levelID = ?').get(id), undefined);
            assert.equal(db.prepare('SELECT commentID FROM comments WHERE levelID = ?').get(id), undefined);
            assert.equal(fs.existsSync(path.join(temporary, `${id}.gdcs`)), false);
        }
    });
    await t.test('captured account-comment deletion infers the omitted target and keeps native account checks', async () => {
        for (const binaryVersion of ['29', '34']) {
            const info = db.prepare("INSERT INTO acccomments (accountID, userName, comment, timestamp) VALUES (72, 'Alice', ?, 0)").run(enc('Account comment'));
            const request = { gameVersion: '20', binaryVersion, accountID: '72', gjp, commentID: String(info.lastInsertRowid), secret: 'Wmfd2893gb7', cType: '1' };
            assert.equal(await post('//deleteGJAccComment20.php', { ...request, gjp: enc(xor('wrong', '37526')) }), '-1');
            assert.equal(await post('//deleteGJAccComment20.php', { ...request, accountID: '73' }), '-1');
            assert.ok(db.prepare('SELECT commentID FROM acccomments WHERE commentID = ?').get(request.commentID));
            assert.equal(await post('//deleteGJAccComment20.php', request), '1');
            assert.equal(db.prepare('SELECT commentID FROM acccomments WHERE commentID = ?').get(request.commentID), undefined);
        }
    });
    await t.test('captured 2.0 friend request text is valid and works when recipient allows text', async () => {
        const captured = { gameVersion: '20', binaryVersion: '29', accountID: '72', gjp, toAccountID: '73', comment: 'Pw==', secret: 'Wmfd2893gb7' };
        db.prepare('DELETE FROM friendreqs WHERE accountID = 72 AND toAccountID = 73').run();
        db.prepare('UPDATE profiles SET frS = 0 WHERE accountID = 73').run();
        assert.equal(await post('//uploadFriendRequest20.php', captured), '-1');
        assert.equal(await post('//uploadFriendRequest20.php', { ...captured, comment: '' }), '1');
        db.prepare('DELETE FROM friendreqs WHERE accountID = 72 AND toAccountID = 73').run();
        // A recipient changing the classic "all" setting explicitly opts in to text.
        const settings = { gameVersion: '20', binaryVersion: '29', accountID: '73', gjp, frS: '0', secret: 'Wmfv3899gc9' };
        assert.equal(await post('/updateGJAccSettings20.php', { ...settings, gjp: enc(xor('wrong', '37526')) }), '-1');
        assert.equal(db.prepare('SELECT frS FROM profiles WHERE accountID = 73').get().frS, 0);
        assert.equal(await post('/updateGJAccSettings20.php', settings), '1');
        assert.equal(db.prepare('SELECT frS FROM profiles WHERE accountID = 73').get().frS, 2);
        const legacyProfile = fields(await post('/getGJUserInfo20.php', { gameVersion: '20', binaryVersion: '29', targetAccountID: '73' }));
        assert.equal(legacyProfile['19'], '0');
        const currentProfile = fields(await post('/getGJUserInfo20.php', { gameVersion: '22', targetAccountID: '73' }));
        assert.equal(currentProfile['19'], '2');
        const currentGJPProfile = fields(await post('/getGJUserInfo20.php', { gameVersion: '22', accountID: '72', gjp, targetAccountID: '73' }));
        assert.equal(currentGJPProfile['19'], '2');
        assert.equal(await post('//uploadFriendRequest20.php', captured), '1');
        assert.equal(db.prepare('SELECT comment FROM friendreqs WHERE accountID = 72 AND toAccountID = 73').get().comment, 'Pw==');
        const inbox = await post('/getGJFriendRequests20.php', { gameVersion: '20', binaryVersion: '29', accountID: '73', gjp, page: '0' });
        assert.equal(fields(inbox.split('#')[0])['35'], 'Pw==');
        // Modern no-text settings retain their original meaning.
        assert.equal(await post('/updateGJAccSettings20.php', { ...settings, gameVersion: '22', gjp: undefined, gjp2 }), '1');
        assert.equal(db.prepare('SELECT frS FROM profiles WHERE accountID = 73').get().frS, 0);
    });
    await t.test('captured 2.0 legacy message works for friends and respects recipient message settings', async () => {
        const captured = { gameVersion: '20', binaryVersion: '29', accountID: '72', gjp, toAccountID: '73', subject: 'UmU6IGhleQ==', body: 'WVFL', secret: 'Wmfd2893gb7' };
        db.prepare('UPDATE profiles SET mS = 1 WHERE accountID = 73').run();
        assert.equal(await post('//uploadGJMessage20.php', captured), '-1');
        const friendship = db.prepare('INSERT INTO friendships (person1, person2, isNew1, isNew2) VALUES (72, 73, 0, 0)').run();
        assert.equal(await post('//uploadGJMessage20.php', captured), '1');
        const message = db.prepare('SELECT ID, subject, body FROM messages WHERE accID = 72 AND toAccountID = 73 ORDER BY ID DESC LIMIT 1').get();
        assert.equal(message.subject, captured.subject);
        assert.equal(message.body, captured.body);
        const received = await post('/downloadGJMessage20.php', { gameVersion: '20', binaryVersion: '29', accountID: '73', gjp, messageID: String(message.ID) });
        assert.equal(fields(received)['4'], captured.subject);
        assert.equal(fields(received)['5'], captured.body);
        db.prepare('UPDATE profiles SET mS = 2 WHERE accountID = 73').run();
        assert.equal(await post('//uploadGJMessage20.php', captured), '-1');
        db.prepare('DELETE FROM friendships WHERE ID = ?').run(friendship.lastInsertRowid);
        db.prepare('UPDATE profiles SET mS = 0 WHERE accountID = 73').run();
        assert.equal(await post('//uploadGJMessage20.php', captured), '1');
        const block = db.prepare('INSERT INTO blocks (person1, person2) VALUES (73, 72)').run();
        assert.equal(await post('//uploadGJMessage20.php', captured), '-1');
        db.prepare('DELETE FROM blocks WHERE ID = ?').run(block.lastInsertRowid);
    });
    await t.test('paired 2.0 and 2.2 friend requests depend on recipient policy and reverse pending requests, not sender mS', async () => {
        const clear = () => db.prepare(`DELETE FROM friendreqs WHERE
            (accountID = 72 AND toAccountID = 73) OR (accountID = 73 AND toAccountID = 72)`).run();
        clear();
        db.prepare('UPDATE profiles SET frS = 2 WHERE accountID IN (72, 73)').run();
        // Captured payloads send in opposite directions; use fixture credentials/account IDs.
        const oldClient = { gameVersion: '20', binaryVersion: '29', accountID: '72', gjp, toAccountID: '73', comment: 'aGk=', secret: 'Wmfd2893gb7' };
        const currentClient = { gameVersion: '22', binaryVersion: '45', udid: 'current-client-device', uuid: '74', accountID: '73', gjp2,
            toAccountID: '72', comment: 'aGk=', secret: 'Wmfd2893gb7' };
        for (const mS of [0, 1]) {
            db.prepare('UPDATE profiles SET mS = ? WHERE accountID = 72').run(mS);
            assert.equal(await post('//uploadFriendRequest20.php', oldClient), '1');
            assert.equal(db.prepare('SELECT comment FROM friendreqs WHERE accountID = 72 AND toAccountID = 73').get().comment, 'aGk=');
            clear();
        }
        assert.equal(await post('/uploadFriendRequest20.php', currentClient), '1');
        assert.equal(await post('//uploadFriendRequest20.php', oldClient), '-1');
        const incoming = fields(await post('/getGJUserInfo20.php', { ...oldClient, targetAccountID: '73' }));
        assert.equal(incoming['31'], '3');
        assert.equal(incoming['35'], 'aGk=');
        clear();
        assert.equal(await post('//uploadFriendRequest20.php', oldClient), '1');
        assert.equal(await post('/uploadFriendRequest20.php', currentClient), '-1');
        clear();
        db.prepare('UPDATE profiles SET frS = 0 WHERE accountID = 73').run();
        assert.equal(await post('//uploadFriendRequest20.php', oldClient), '-1');
        assert.equal(await post('/uploadFriendRequest20.php', currentClient), '1');
        clear();
    });
    await t.test('message bridge welcomes accounts, authenticates commands and forwards only opted-in DMs', async () => {
        assert.equal(await post('/accounts/registerGJAccount.php', { userName: 'BridgeUser', password, rsession: 'test', secret: 'Wmfv3899gc9', gameVersion: '22' }, undefined, undefined, { secure: true }), '1');
        const id = db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('BridgeUser').accountID;
        const greeting = db.prepare('SELECT * FROM messages WHERE toAccountID = ? AND accID = 71 ORDER BY ID').all(id);
        const greetingText = greeting.map(message => xor(Buffer.from(message.body, 'base64').toString(), '14251').toString()).join('');
        assert.match(greetingText, /message_bridge 1/);
        assert.match(greetingText, /subscribe_news/);
        const clientAuth = { accountID: String(id), gjp2, gameVersion: '22' };
        const rows = (await post('/getGJThreads.php', clientAuth)).split('#')[0].split('|').map(row => row.split(':'));
        const system = rows.find(row => row[1] === '71');
        assert.ok(system);
        assert.equal(system[25], '0');
        const metadata = (await post('/getGJThreadMessages.php', { ...clientAuth, threadID: system[0] })).split('#')[4].split(':');
        assert.equal(metadata[10], '0');
        assert.match(await post('/sendGJThreadMessage.php', { ...clientAuth, threadID: system[0], body: enc('legacy_notif 1') }), /^\d+:\d+$/);
        const legacyAuth = { ...auth, accountID: String(id), toAccountID: '71', subject: enc('Bridge'), body: enc(xor('message_bridge 1', '14251')) };
        assert.equal(await post('/uploadGJMessage20.php', { ...legacyAuth, gjp: enc(xor('wrong', '37526')) }), '-1');
        assert.equal(await post('/uploadGJMessage20.php', legacyAuth), '1');
        const thread = db.prepare('INSERT INTO threads (isDM, ownerID, createdAt, updatedAt) VALUES (1, 72, 1, 1)').run().lastInsertRowid;
        db.prepare('INSERT INTO thread_members (threadID, accountID, status) VALUES (?, 72, 1), (?, ?, 1)').run(thread, thread, id);
        const sent = await post('/sendGJThreadMessage.php', { accountID: '72', gjp2, gameVersion: '22', threadID: String(thread), body: enc('Hello from a new DM') });
        assert.match(sent, /^\d+:\d+$/);
        const forwarded = db.prepare('SELECT * FROM messages WHERE accID = 72 AND toAccountID = ? ORDER BY ID DESC').get(id);
        assert.equal(xor(Buffer.from(forwarded.body, 'base64').toString(), '14251').toString(), 'Hello from a new DM');
        assert.equal(await post('/uploadGJMessage20.php', { ...legacyAuth, body: enc(xor('message_bridge 0', '14251')) }), '1');
        assert.match(await post('/sendGJThreadMessage.php', { accountID: String(id), gjp2, isDM: '1', toAccountID: '71', body: enc('message_bridge 0') }), /^\d+:\d+$/);
        const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE accID = 72 AND toAccountID = ?').get(id).n;
        await post('/sendGJThreadMessage.php', { accountID: '72', gjp2, gameVersion: '22', threadID: String(thread), body: enc('No forwarding') });
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE accID = 72 AND toAccountID = ?').get(id).n, count);
    });
    await t.test('legacy replies reuse DMs without echoes and notification preferences persist', async () => {
        const recipient = db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('BridgeUser').accountID;
        const modernAuth = { accountID: String(recipient), gjp2, gameVersion: '22', isDM: '1', toAccountID: '71' };
        assert.match(await post('/sendGJThreadMessage.php', { ...modernAuth, body: enc('message_bridge 1') }), /^\d+:\d+$/);
        const existing = db.prepare(`SELECT t.threadID FROM threads t JOIN thread_members m ON m.threadID = t.threadID
            WHERE t.ownerID = 72 AND t.isDM = 1 AND m.accountID = ?`).get(recipient).threadID;
        const request = { ...auth, toAccountID: String(recipient), subject: enc('A legacy reply'), body: enc(xor('Reply body', '14251')) };
        const countLegacy = () => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE accID = 72 AND toAccountID = ?').get(recipient).n;
        const countNotices = () => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE toAccountID = ?').get(recipient).n;
        assert.equal(await post('/uploadGJMessage20.php', request), '-1'); // Friends-only by default.
        db.prepare('UPDATE profiles SET mS = 0 WHERE accountID = ?').run(recipient);
        const before = countLegacy();
        const notices = countNotices();
        assert.equal(await post('/uploadGJMessage20.php', request), '1');
        assert.equal(countLegacy(), before + 1);
        assert.equal(countNotices(), notices + 1);
        const translated = db.prepare('SELECT * FROM thread_messages WHERE threadID = ? ORDER BY messageID DESC LIMIT 1').get(existing);
        assert.equal(translated.accountID, 72);
        assert.equal(Buffer.from(translated.content, 'base64').toString(), 'A legacy reply\n\nReply body');
        assert.equal(await post('/sendGJThreadMessage.php', { ...modernAuth, gjp2: 'x'.repeat(40), body: enc('legacy_notif 0') }), '-1');
        assert.match(await post('/sendGJThreadMessage.php', { ...modernAuth, body: enc('legacy_notif 0') }), /^\d+:\d+$/);
        assert.equal(db.prepare('SELECT enabled FROM legacy_compat_notifications WHERE accountID = ?').get(recipient).enabled, 0);
        assert.equal(await post('/uploadGJMessage20.php', request), '1');
        assert.equal(countNotices(), notices + 1);
        assert.equal(countLegacy(), before + 2);
        assert.equal(await post('/uploadGJMessage20.php', { ...auth, accountID: String(recipient), toAccountID: '71', subject: enc('Settings'), body: enc(xor('legacy_notif 1', '14251')) }), '1');
        assert.equal(await post('/uploadGJMessage20.php', request), '1');
        assert.equal(countNotices(), notices + 2);
        // A recipient without a prior DM gets a conversation with the original sender.
        assert.equal(await post('/accounts/registerGJAccount.php', { userName: 'FreshBridge', password, rsession: 'test', secret: 'Wmfv3899gc9', gameVersion: '22' }, undefined, undefined, { secure: true }), '1');
        const fresh = db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('FreshBridge').accountID;
        db.prepare('UPDATE profiles SET mS = 0 WHERE accountID = ?').run(fresh);
        assert.equal(await post('/uploadGJMessage20.php', { ...request, toAccountID: String(fresh) }), '1');
        const conversation = db.prepare(`SELECT t.threadID FROM threads t JOIN thread_members m ON m.threadID = t.threadID
            WHERE t.ownerID = 72 AND t.isDM = 1 AND m.accountID = ?`).get(fresh);
        assert.ok(conversation);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM thread_messages WHERE threadID = ?').get(conversation.threadID).n, 1);
    });
    await t.test('bridge strips generated reply subjects and escapes UTF-8 bytes within legacy size limits', async () => {
        const recipient = db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('BridgeUser').accountID;
        const thread = db.prepare(`SELECT t.threadID FROM threads t JOIN thread_members m ON m.threadID = t.threadID
            WHERE t.ownerID = 72 AND t.isDM = 1 AND m.accountID = ?`).get(recipient).threadID;
        for (const subject of ['Re: New DM', 'Re: Re: New DM', 'New DM']) {
            assert.equal(await post('/uploadGJMessage20.php', { ...auth, toAccountID: String(recipient), subject: enc(subject), body: enc(xor('Clean reply', '14251')) }), '1');
            const reply = db.prepare('SELECT content FROM thread_messages WHERE threadID = ? ORDER BY messageID DESC LIMIT 1').get(thread);
            assert.equal(Buffer.from(reply.content, 'base64').toString(), 'Clean reply');
        }
        const cursor = db.prepare('SELECT COALESCE(MAX(ID), 0) AS id FROM messages').get().id;
        const text = 'ASCII é Ї 😀'.repeat(18);
        assert.match(await post('/sendGJThreadMessage.php', { accountID: '72', gjp2, gameVersion: '22', threadID: String(thread), body: enc(text) }), /^\d+:\d+$/);
        const copies = db.prepare('SELECT body FROM messages WHERE ID > ? AND accID = 72 AND toAccountID = ? ORDER BY ID').all(cursor, recipient);
        assert.ok(copies.length > 1);
        const parts = copies.map(copy => xor(Buffer.from(copy.body, 'base64').toString(), '14251').toString());
        assert.ok(copies.every(copy => copy.body.length <= 270));
        assert.ok(parts.every(part => /^[\x00-\x7F]*$/.test(part)));
        assert.equal(parts.join(''), String.raw`ASCII \xC3\xA9 \xD0\x87 \xF0\x9F\x98\x80`.repeat(18));
        assert.ok(parts.every(part => !/\\x(?:[0-9A-F]?)$/.test(part)));
        assert.equal((await post('/getGJThreads.php', { accountID: '72', gjp2, gameVersion: '22' })).split('#')[0].split('|').map(row => row.split(':')).find(row => Number(row[1]) === recipient)[25], '4');
    });
    await t.test('legacy group invites, commands and chat follow core membership rules', async () => {
        const ids = [];
        for (const name of ['GroupOwner', 'GroupAlice', 'GroupBob', 'GroupOutsider']) {
            assert.equal(await post('/accounts/registerGJAccount.php', { userName: name, password, rsession: 'test', secret: 'Wmfv3899gc9', gameVersion: '22' }, undefined, undefined, { secure: true }), '1');
            ids.push(db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get(name).accountID);
        }
        const [owner, alice, bob, outsider] = ids;
        for (const id of [alice, bob]) db.prepare('INSERT INTO friendships (person1, person2, isNew1, isNew2) VALUES (?, ?, 0, 0)').run(owner, id);
        const modern = id => ({ accountID: String(id), gjp2, gameVersion: '22' });
        const legacyCommand = (id, command, subject = 'Command') => post('/uploadGJMessage20.php', { ...auth, accountID: String(id), toAccountID: '71', subject: enc(subject), body: enc(xor(command, '14251')) });
        const inbox = id => db.prepare('SELECT * FROM messages WHERE toAccountID = ? AND accID = 71 ORDER BY ID').all(id);
        const plaintext = message => xor(Buffer.from(message.body, 'base64').toString(), '14251').toString();
        const created = await post('/sendGJThreadMessage.php', { ...modern(owner), subject: enc('Legacy Club'), description: enc('A cross-version group'), targets: enc(`${alice},${bob}`), body: '' });
        assert.match(created, /^\d+:\d+:2:0$/);
        const group = Number(created.split(':')[0]);
        const invitation = inbox(alice).filter(message => Buffer.from(message.subject, 'base64').toString() === 'Legacy Club');
        assert.ok(invitation.length);
        const inviteText = invitation.map(plaintext).join('');
        assert.match(inviteText, /A cross-version group/);
        assert.ok(inviteText.includes(`accept_group ${group}`));
        assert.ok(inviteText.includes(`deny_group ${group}`));
        assert.equal(await legacyCommand(outsider, `accept_group ${group}`), '-1');
        assert.equal(await legacyCommand(outsider, `list_group_members ${group}`), '-1');
        assert.equal(await legacyCommand(outsider, `report_group ${group}`), '-1');
        assert.equal(await legacyCommand(alice, 'Premature', `group ${group}`), '-1');
        assert.equal(await legacyCommand(alice, `accept_group ${group}`), '1');
        assert.equal(await legacyCommand(alice, `accept_group ${group}`), '-1');
        assert.equal(await legacyCommand(bob, `deny_group ${group}`), '1');
        assert.equal(db.prepare('SELECT ignoredInvite FROM thread_members WHERE threadID = ? AND accountID = ?').get(group, bob).ignoredInvite, 1);
        const beforeBob = inbox(bob).length;
        assert.match(await post('/sendGJThreadMessage.php', { ...modern(owner), threadID: String(group), body: enc('Hello legacy group!') }), /^\d+:\d+$/);
        assert.equal(inbox(bob).length, beforeBob);
        const received = inbox(alice).filter(message => Buffer.from(message.subject, 'base64').toString() === 'Group Legacy Club: GroupOwner');
        assert.equal(received.length, 1);
        assert.match(plaintext(received[0]), /Hello legacy group!/);
        assert.equal(await legacyCommand(alice, 'Hello modern group!', `group ${group}`), '1');
        const latest = db.prepare('SELECT * FROM thread_messages WHERE threadID = ? ORDER BY messageID DESC LIMIT 1').get(group);
        assert.equal(latest.accountID, alice);
        assert.equal(Buffer.from(latest.content, 'base64').toString(), 'Hello modern group!');
        assert.equal(inbox(owner).filter(message => Buffer.from(message.subject, 'base64').toString() === 'Group Legacy Club: GroupAlice').length, 1);
        assert.equal(await legacyCommand(alice, `list_group_members ${group}`), '1');
        assert.ok(inbox(alice).slice(-1).map(plaintext).join('').includes('GroupAlice'));
        assert.equal(await legacyCommand(alice, 'list_joined_groups'), '1');
        assert.equal(plaintext(inbox(alice).slice(-1)[0]), `${group} - Legacy Club`);
        assert.equal(await legacyCommand(alice, `report_group ${group}`), '1');
        const report = db.prepare('SELECT * FROM reports WHERE accountID = ? AND targetID = ?').get(alice, group);
        assert.equal(report.type, 8);
        assert.equal(report.reasons, '0');
        db.prepare('UPDATE threads SET locked = 1 WHERE threadID = ?').run(group);
        assert.equal(await legacyCommand(alice, 'Locked', `group ${group}`), '-1');
        db.prepare('UPDATE threads SET locked = 0 WHERE threadID = ?').run(group);
        // The bridge uses the same 20 messages/minute limit as current clients.
        db.prepare('UPDATE thread_messages SET timestamp = 1 WHERE accountID = ?').run(alice);
        for (let i = 0; i < 20; i++) db.prepare('INSERT INTO thread_messages (threadID, accountID, content, timestamp, isSystem) VALUES (?, ?, ?, ?, 0)').run(group, alice, enc('Rate limit fixture'), Math.floor(Date.now() / 1000));
        assert.equal(await legacyCommand(alice, 'Rate limited', `group ${group}`), '-1');
        assert.equal(await legacyCommand(alice, `leave_group ${group}`), '1');
        assert.equal(await legacyCommand(alice, 'After leaving', `group ${group}`), '-1');
        const afterLeave = inbox(alice).length;
        assert.equal(await legacyCommand(alice, `list_group_members ${group}`), '-1');
        assert.equal(inbox(alice).length, afterLeave);
        assert.equal(await legacyCommand(alice, 'list_joined_groups'), '1');
        assert.equal(plaintext(inbox(alice).slice(-1)[0]), 'No joined groups.');
        // Reinviting a former member produces another legacy invitation.
        const invitesBefore = inbox(alice).filter(message => Buffer.from(message.subject, 'base64').toString() === 'Legacy Club').length;
        assert.match(await post('/updateGJThread.php', { ...modern(owner), threadID: String(group), mode: '4', value: enc(String(alice)) }), /^:/);
        assert.ok(inbox(alice).filter(message => Buffer.from(message.subject, 'base64').toString() === 'Legacy Club').length > invitesBefore);
        assert.equal(await legacyCommand(alice, `accept_group ${group}`), '1');
        assert.equal(await legacyCommand(owner, `leave_group ${group}`), '1');
        assert.equal(db.prepare('SELECT ownerID FROM threads WHERE threadID = ?').get(group).ownerID, alice);
        assert.equal(await legacyCommand(alice, `leave_group ${group}`), '1');
        assert.equal(db.prepare('SELECT 1 FROM threads WHERE threadID = ?').get(group), undefined);
    });
    await t.test('news subscriptions deliver only newly published local articles with image footers', async () => {
        db.prepare('INSERT OR IGNORE INTO dashboard_news_settings (id, version) VALUES (1, 1001)').run();
        const article = (id, extra = {}) => ({ id, publishDate: 'November 11, 2026', title: `Article ${id}`, body: `Text of article ${id}`, ...extra });
        newsContent.saveNewsItems([article(1)]);
        const alice = db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('BridgeUser').accountID;
        const bob = db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('FreshBridge').accountID;
        const command = (id, text, extra = {}) => post('/uploadGJMessage20.php', { ...auth, accountID: String(id), toAccountID: '71', subject: enc('News'), body: enc(xor(text, '14251')), ...extra });
        const copies = id => db.prepare('SELECT * FROM messages WHERE toAccountID = ? AND accID = 71 ORDER BY ID').all(id)
            .filter(message => Buffer.from(message.subject, 'base64').toString().startsWith('News: '));
        const text = messages => messages.map(message => xor(Buffer.from(message.body, 'base64').toString(), '14251').toString()).join('');
        assert.equal(await command(alice, 'subscribe_news', { gjp: enc(xor('wrong', '37526')) }), '-1');
        assert.equal(await command(alice, 'subscribe_news'), '1');
        assert.equal(await command(alice, 'subscribe_news'), '1');
        assert.equal(copies(alice).length, 0); // No backlog on subscription.
        // Put the footer across a normal chunk boundary to verify it stays intact.
        const announcement = 'A long announcement. '.repeat(17);
        const header = 'Article 2\nNovember 11, 2026\n\n';
        const padding = (190 - (header.length + announcement.length) % 195 + 195) % 195;
        newsContent.saveNewsItems([article(1), article(2, { body: announcement + 'X'.repeat(padding), imageFile: 'launch.png' })]);
        const delivered = copies(alice);
        assert.ok(delivered.length > 1);
        assert.ok(delivered.every(message => message.body.length <= 270));
        assert.ok(text(delivered).includes('A long announcement. '.repeat(17).trim()));
        assert.ok(text(delivered.slice(-1)).endsWith('[Image attached: launch.png]'));
        assert.ok(text(delivered).endsWith('[Image attached: launch.png]'));
        assert.equal(copies(bob).length, 0);
        const count = delivered.length;
        newsContent.saveNewsItems([article(1), article(2, { body: 'Edited article', imageFile: 'launch.png' })]);
        assert.equal(copies(alice).length, count); // Editing is not a publication.
        const next = [article(1), article(2), article(3), article(4, { body: '', imageFile: 'image-only.jpg' })];
        newsContent.saveNewsItems(next);
        const newest = copies(alice).slice(count);
        assert.ok(text(newest).startsWith('Article 4'));
        assert.ok(text(newest).endsWith('[Image attached: image-only.jpg]'));
        assert.ok(!text(newest).includes('Article 3')); // Only the latest new article in a save.
        const afterBatch = copies(alice).length;
        newsContent.saveNewsItems(next);
        assert.equal(copies(alice).length, afterBatch);
        assert.equal(await command(bob, 'subscribe_news'), '1');
        db.prepare('UPDATE accounts SET isDisabled = 1 WHERE accountID = ?').run(bob);
        newsContent.saveNewsItems([...next, article(5)]);
        db.prepare('UPDATE accounts SET isDisabled = 0 WHERE accountID = ?').run(bob);
        assert.equal(copies(bob).length, 0);
        assert.ok(!text(copies(alice).slice(afterBatch)).includes('[Image attached:'));
        assert.equal(await command(alice, 'unsubscribe_news'), '1');
        const afterUnsubscribe = copies(alice).length;
        newsContent.saveNewsItems([...next, article(5), article(6)]);
        assert.equal(copies(alice).length, afterUnsubscribe);
        assert.ok(text(copies(bob)).includes('Article 6'));

        // A static/official feed takes precedence over the dashboard; never send its copies.
        const staticPath = path.join(temporary, 'official-news.dat');
        fs.writeFileSync(staticPath, 'Copied official feed');
        let publish;
        const sent = [];
        require('../newsBridge')({ db, registerHook(name, handler) { publish = handler; } }, (...args) => sent.push(args), { staticNewsPath: staticPath });
        db.prepare('INSERT INTO dashboard_news (newsID, publishDate, title, body) VALUES (7, ?, ?, ?)').run('Today', 'Static override', 'Should not be delivered');
        publish({ method: 'run', sql: 'UPDATE dashboard_news_settings SET version = version + 1 WHERE id = 1', execute: () => ({ changes: 1 }) });
        assert.equal(sent.length, 0);
        fs.unlinkSync(staticPath);
        // Re-enabling local news must not replay articles suppressed by the static feed.
        publish({ method: 'run', sql: 'UPDATE dashboard_news_settings SET version = version + 1 WHERE id = 1', execute: () => ({ changes: 1 }) });
        assert.equal(sent.length, 0);
    });
    await t.test('guests never consume the first registered administrator account', async () => {
        db.exec('DELETE FROM legacy_compat_guests; DELETE FROM accounts; DELETE FROM profiles;');
        const guestID = await post('/updateGJUserScore.php', { gameVersion: '18', udid: 'fresh-device', userName: 'Guest' });
        assert.match(guestID, /^\d+$/);
        assert.notEqual(guestID, '73');
        assert.equal(await post('/accounts/registerGJAccount.php', { userName: 'FirstAdmin', password, secret: 'Wmfv3899gc9', gameVersion: '19' }, undefined, undefined, { secure: true }), '1');
        assert.equal(db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('FirstAdmin').accountID, 72);
        assert.equal(db.prepare('SELECT modLevel FROM profiles WHERE accountID = 72').get().modLevel, 2);
        assert.equal(await post('/accounts/registerGJAccount.php', { userName: 'SecondUser', password, secret: 'Wmfv3899gc9' }, undefined, undefined, { secure: true }), '1');
        db.prepare('DELETE FROM accounts WHERE accountID = 72').run();
        assert.equal(await post('/accounts/registerGJAccount.php', { userName: 'ThirdUser', password, secret: 'Wmfv3899gc9' }, undefined, undefined, { secure: true }), '1');
        assert.notEqual(db.prepare('SELECT accountID FROM accounts WHERE userName = ?').get('ThirdUser').accountID, 72);
    });
    assert.ok(statements.some(sql => /gameVersion <= 19/.test(sql)));
});
