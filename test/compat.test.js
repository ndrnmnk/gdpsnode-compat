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
const httpsGuardEnabled = fs.readFileSync(path.join(root, 'plugins/legacy-compat/index.js'), 'utf8')
    .split('\n').some(line => line.trim() === "Object.hasOwn(body, 'password') && req.secure !== true) {");
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
    'comments/getGJComments21', 'comments/uploadGJComment21',
    'accounts/loginGJAccount', 'accounts/registerGJAccount', 'accounts/syncGJAccountNew', 'accounts/backupGJAccountNew',
    'levels/getGJMapPacks21', 'levels/getGJGauntlets21', 'levels/getGJChallenges', 'users/getGJUserInfo20',
    'messages/getGJMessages20', 'messages/downloadGJMessage20', 'rewards/getGJRewards'
];
for (const name of endpoints) {
    const endpoint = require(path.join(root, 'endpoints', name));
    app.post(endpoint.path, ...(endpoint.middleware || []), endpoint.handler);
}
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
    const questRequest = { gameVersion: '20', binaryVersion: '34', gdw: '0', accountID: '72', gjp,
        udid: 'ffffffff-bc90-02e8-0033-c5870033c587', uuid: '73', world: '0', secret: 'Wmfd2893gb7', chk: 'RL84HAAwBAQIF' };
    function questFields(wire) {
        assert.ok(wire.startsWith('SaKuJ'));
        const [encoded, hash] = wire.slice(5).split('|');
        assert.equal(hash, crypto.createHash('sha1').update(encoded + 'oC36fpYaPtdg').digest('hex'));
        return utils.xorCipher(Buffer.from(encoded, 'base64'), '19847').toString().split(':');
    }
    await t.test('captured quest request returns a valid legacy response even with no configured quests', async () => {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM quests').get().count, 0);
        const nonce = utils.xorCipher(Buffer.from(questRequest.chk.slice(5), 'base64'), '19847').toString();
        const requests = [questRequest, { ...questRequest, accountID: '0', gjp: '0', uuid: '0', udid: 'test-device' }];
        for (const request of requests) {
            const parts = questFields(await post('//getGJChallenges.php', request));
            assert.equal(parts.length, 9);
            assert.equal(parts[0], 'SaKuJ');
            assert.equal(parts[2], nonce);
            assert.equal(parts[3], request.udid);
            assert.equal(parts[4], request.accountID);
            if (request.accountID === '72') assert.equal(parts[1], '73');
            assert.ok(Number(parts[5]) > 0 && Number(parts[5]) <= 86400);
            const records = parts.slice(6).map(quest => quest.split(','));
            assert.deepEqual(records.map(row => Number(row[1])).sort(), [1, 2, 3]);
            assert.deepEqual(records.map(row => Number(row[0])), [Number(records[0][0]), Number(records[0][0]) + 1, Number(records[0][0]) + 2]);
            assert.ok(records.every(row => row.length === 5 && Number(row[2]) > 0 && Number(row[3]) > 0 && row[4]));
            const again = questFields(await post('/getGJChallenges.php', request));
            assert.deepEqual(again.slice(6), parts.slice(6));
        }
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM quests').get().count, 0);
        // The plugin's fallback does not replace the current handler for 2.2 clients.
        assert.equal(await post('/getGJChallenges.php', { gameVersion: '22', accountID: '72', gjp2, uuid: '73', udid: questRequest.udid, chk: questRequest.chk }), '-1');
    });
    await t.test('quests use configured records, fill incomplete configuration and share UTC expiration with IDs', async () => {
        for (const [type, name] of [[1, 'Custom Orbs'], [2, 'Custom Coins'], [3, 'Custom Stars']]) {
            db.prepare('INSERT INTO quests (type, amount, reward, name) VALUES (?, 12, 7, ?)').run(type, name);
        }
        const parts = questFields(await post('/getGJChallenges.php', questRequest));
        assert.deepEqual(parts.slice(6).map(q => q.split(',')[4]).sort(), ['Custom Coins', 'Custom Orbs', 'Custom Stars']);
        const legacyChallenges = require('../legacyChallenges');
        const before = questFields(legacyChallenges.response(db, { ...questRequest, gjp2 }, Date.UTC(2026, 10, 1, 23, 59, 59)));
        const after = questFields(legacyChallenges.response(db, { ...questRequest, gjp2 }, Date.UTC(2026, 10, 2)));
        assert.equal(before[5], '1');
        assert.equal(after[5], '86400');
        assert.equal(Number(after[6].split(',')[0]) - Number(before[6].split(',')[0]), 3);
        db.prepare('DELETE FROM quests WHERE type != 1').run();
        const mixed = questFields(await post('/getGJChallenges.php', questRequest));
        assert.equal(mixed.slice(6).length, 3);
        assert.ok(mixed.slice(6).some(q => q.endsWith(',Custom Orbs')));
    });
    await t.test('legacy quests reject incorrect credentials, secrets, identities and challenge tokens', async () => {
        assert.equal(await post('/getGJChallenges.php', { ...questRequest, gjp: enc(xor('wrong', '37526')) }), '-1');
        assert.equal(await post('/getGJChallenges.php', { ...questRequest, secret: 'bad' }), '-1');
        assert.equal(await post('/getGJChallenges.php', { ...questRequest, udid: '123' }), '-1');
        for (const chk of ['', '12345', 'ABCDE!!!!']) assert.equal(await post('/getGJChallenges.php', { ...questRequest, chk }), '-1');
        db.prepare('UPDATE accounts SET isDisabled = 1 WHERE accountID = 72').run();
        assert.equal(await post('/getGJChallenges.php', questRequest), '-1');
        db.prepare('UPDATE accounts SET isDisabled = 0 WHERE accountID = 72').run();
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
