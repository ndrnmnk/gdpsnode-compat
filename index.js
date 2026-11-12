'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { AsyncLocalStorage } = require('node:async_hooks');
const { promisify } = require('node:util');
const legacyLikes = require('./legacyLikes');
const legacyGauntlets = require('./legacyGauntlets');
const legacyUsers = require('./legacyUsers');
const config = require('./config.js');
const unzip = promisify(zlib.unzip);
const gzip = promisify(zlib.gzip);
const MAX_BYTES = 50 * 1024 * 1024;
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const encode = value => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const decode = value => Buffer.from(value, 'base64');
const xor = (value, key) => Buffer.from(Array.from(value, (c, i) => c.charCodeAt(0) ^ key.charCodeAt(i % key.length)));
const clean = value => value.replace(/[:~|#]/g, '');

const aliases = {};
function alias(names, target) {
    for (const name of names.split(' ')) aliases[`/${name}.php`] = `/${target}.php`;
}
alias('getGJLevels getGJLevels19 getGJLevels20', 'getGJLevels21');
alias('downloadGJLevel downloadGJLevel19 downloadGJLevel20 downloadGJLevel21', 'downloadGJLevel22');
alias('uploadGJLevel uploadGJLevel19 uploadGJLevel20', 'uploadGJLevel21');
alias('updateGJUserScore updateGJUserScore19 updateGJUserScore20 updateGJUserScore21', 'updateGJUserScore22');
alias('getGJComments getGJComments19 getGJComments20', 'getGJComments21');
alias('uploadGJComment uploadGJComment19 uploadGJComment20', 'uploadGJComment21');
alias('deleteGJComment deleteGJComment19', 'deleteGJComment20');
alias('deleteGJLevelUser deleteGJLevelUser19', 'deleteGJLevelUser20');
alias('getGJScores getGJScores19 getGJCreators getGJCreators19', 'getGJScores20');
alias('getGJMapPacks getGJMapPacks20', 'getGJMapPacks21');
alias('getGJGauntlets', 'getGJGauntlets21');
alias('getGJLevelScores', 'getGJLevelScores211');
alias('likeGJLevel likeGJItem likeGJItem19 likeGJItem20 likeGJItem21', 'likeGJItem211');
alias('rateGJStars rateGJStars20', 'rateGJStars211');
alias('rateGJLevel', 'rateGJStars211');
alias('reportGJLevel', 'reportGJContent');
for (const operation of ['backup', 'sync']) {
    alias(`accounts/${operation}GJAccount accounts/${operation}GJAccount20 accounts/${operation}GJAccountNew database/accounts/${operation}GJAccount database/accounts/${operation}GJAccount20`, `database/accounts/${operation}GJAccountNew`);
}

function version(body, path) {
    let value = Number(body.gameVersion);
    if (!Number.isInteger(value) || value < 1) {
        if (/(?:19)\.php$/.test(path)) value = 19;
        else if (/(?:20)\.php$/.test(path)) value = 20;
        else if (/(?:21|211)\.php$/.test(path)) value = 21;
        else if (path === '/rateGJStars.php') value = 19;
        else if (typeof body.password === 'string' && /GJAccount/.test(path)) value = 19;
        else value = aliases[path] ? 18 : typeof body.gjp === 'string' ? 21 : 22;
    }
    // 2.01 reports binaryVersion=29. World starts at 30 while still
    // reporting gameVersion=20; do not tag 2.01 uploads as 2.1 levels.
    return value === 20 && Number(body.binaryVersion) >= 30 ? 21 : value;
}

function pairs(value, delimiter, change) {
    const fields = value.split(delimiter);
    for (let i = 0; i + 1 < fields.length; i += 2) fields[i + 1] = change(fields[i], fields[i + 1]);
    return fields.join(delimiter);
}

async function responseFor(text, state) {
    if (typeof text !== 'string' || /^-\d+$/.test(text)) return text;
    const { target, gameVersion, binaryVersion } = state;
    text = legacyUsers.rewrite(state.db, target, text);
    const sections = text.split('#');
    if (target === '/getGJRewards.php' && state.guestRewards) {
        const encoded = text.slice(5).split('|')[0];
        const fields = xor(decode(encoded).toString('binary'), '59182').toString().split(':');
        if (fields.length !== 12) return '-1';
        fields[0] = '1';
        fields[1] = String(state.guestRewards.userID);
        fields[4] = '0';
        const payload = encode(xor(fields.join(':'), '59182'));
        return `eNDeR${payload}|${hash(payload + 'pC26fpYaQCtg')}`;
    }
    if (target === '/getGJUserInfo20.php') {
        return pairs(text, ':', (key, value) => {
            if (gameVersion < 22 && key === '19' && value === '2') return '0'; // Classic clients only know all/none.
            return key === '38' && state.messageCount !== undefined ? String(state.messageCount) : value;
        });
    }
    if (target === '/getGJLevels21.php') {
        if (sections.length === 3 && sections[0] === '') sections.splice(1, 0, '', '');
        if (state.gauntlet && !legacyGauntlets.rewrite(sections, state.gauntlet)) return '-1';
        if (gameVersion <= 18 && sections.length === 5) sections.splice(2, 1);
    }
    if (target.endsWith('/syncGJAccountNew.php')) return text.replace(/;22;47;a;a$/, `;${gameVersion};${binaryVersion};a;a`);
    if (target === '/downloadGJLevel22.php') {
        sections[0] = pairs(sections[0], ':', (key, value) => {
            if (key === '3' && gameVersion < 20) return clean(decode(value).toString());
            if (key === '27' && gameVersion < 20) return value === '0' ? '0' : xor(decode(value).toString('binary'), '26364').toString();
            return value;
        });
        if (gameVersion <= 18) {
            const fields = sections[0].split(':');
            for (let i = 0; i < fields.length; i += 2) {
                if (fields[i] === '4') {
                    fields[i + 1] = (await unzip(decode(fields[i + 1]), { maxOutputLength: MAX_BYTES })).toString();
                    // Hash covers the actual wire representation, including uncompressed 1.x levels.
                    sections[1] = downloadHash(fields[i + 1]);
                    break;
                }
            }
            sections[0] = fields.join(':');
        }
    }
    if (target === '/getGJComments21.php') {
        const users = new Map();
        sections[0] = sections[0].split('|').map(row => {
            const [comment, profile] = row.split(':');
            const fields = Object.fromEntries((profile || '').split('~').reduce((a, v, i, arr) => { if (!(i % 2)) a.push([v, arr[i + 1]]); return a; }, []));
            let userID;
            const adapted = pairs(comment, '~', (key, value) => {
                if (key === '3') userID = value;
                return key === '2' && gameVersion < 20 ? clean(decode(value).toString()) : value;
            });
            if (binaryVersion < 32 && fields['1']) users.set(userID, `${userID}:${fields['1']}:${fields['16'] || 0}`);
            return binaryVersion < 32 ? adapted : row;
        }).join('|');
        if (binaryVersion < 32) sections[1] = [...users.values()].join('|');
        else if (sections.length === 3) sections.splice(1, 1);
    }
    return sections.join('#');
}

function downloadHash(value) {
    const step = Math.floor(value.length / 40);
    return hash((value.length < 41 ? value : Array.from({ length: 40 }, (_, i) => value[i * step]).join('')) + 'xI25fpAapCQg');
}

module.exports = {
    name: 'legacy-compat',
    metadata: { version: '1.0.0' },
    install(api) {
        if (config.allow_insecure_login) {
            console.warn('\x1b[1;31m⚠ legacy-compat: allow_insecure_login is enabled! Account passwords may be sent over unencrypted HTTP.\x1b[0m');
        }
        // Run before the bridge, which can answer requests in its own middleware.
        api.use((req, res, next) => {
            const body = req.method === 'GET' ? req.query || {} : req.body || {};
            const binaryVersion = Number(body.binaryVersion ?? 0);
            if (config.min_binary_version > 0 &&
                (!Number.isFinite(binaryVersion) || binaryVersion < config.min_binary_version)) {
                return res.type('text/plain').send('-1');
            }
            return next();
        });
        const messageBridge = config.allow_message_bridge ? require('./messageBridge')(api) : undefined;
        const context = new AsyncLocalStorage();
        api.db.exec(`CREATE TABLE IF NOT EXISTS legacy_compat_guests (
            deviceHash TEXT PRIMARY KEY, accountID INTEGER NOT NULL UNIQUE
        )`);
        legacyLikes.initialize(api.db);
        // Filter before pagination/counting, scoped to the request even across async I/O.
        api.registerHook('database:prepare', request => {
            const state = context.getStore();
            if (state?.includeZeroScores && /^\s*SELECT\s/i.test(request.sql)) {
                request.sql = request.sql.replace(/\s+AND p\.stars > 0\b/g, '');
            }
            // Core grants the first registered account (72) moderator access.
            // Guest activity must neither receive nor consume that account.
            if (state?.target === '/accounts/registerGJAccount.php' &&
                /^INSERT INTO accounts \(userName, gjp2, isDisabled\) VALUES/i.test(request.sql) &&
                !api.db.prepare(`SELECT 1 FROM accounts WHERE accountID >= 72
                    AND accountID NOT IN (SELECT accountID FROM legacy_compat_guests) LIMIT 1`).get()) {
                request.sql = request.sql.replace('(userName,', '(accountID, userName,').replace('VALUES (', 'VALUES (72, ');
            }
            if (['/getGJLevels21.php', '/downloadGJLevel22.php'].includes(state?.target) && state.gameVersion < 22 && /^SELECT\s/i.test(request.sql)) {
                request.sql = request.sql.replace(/\bFROM levels\b/i,
                    `FROM (SELECT * FROM levels WHERE gameVersion <= ${state.gameVersion} AND levelLength != 5) AS levels`);
            }
            return request;
        });
        api.use((req, res, next) => {
            if (req.method !== 'POST') return next();
            const original = req.path;
            const body = req.body || (req.body = {});
            // Express assesses TLS and trusted proxy forwarding in req.secure.
            // Do not trust a raw X-Forwarded-Proto header or the claimed game version.
            if (!config.allow_insecure_login && /^\/accounts\/(?:login|register)GJAccount\.php\/?$/i.test(original) &&
                Object.hasOwn(body, 'password') && req.secure !== true) {
                return res.type('text/plain').send('-1');
            }
            if (!/\.php$/.test(original)) return next();
            const gameVersion = version(body, original);
            const target = aliases[original] || original;
            const unregistered = body.accountID == null || body.accountID === '' || body.accountID === '0';
            const guestOption = {
                '/uploadGJLevel21.php': 'allow_unregistered_level_uploads',
                '/uploadGJComment21.php': 'allow_unregistered_comments',
                '/likeGJItem211.php': 'allow_unregistered_likes',
                '/rateGJStars211.php': 'allow_unregistered_rates'
            }[target];
            if ((original === '/likeGJLevel.php' && !config['allow_1.0_likes']) ||
                (unregistered && guestOption && !config[guestOption])) {
                return res.type('text/plain').send('-1');
            }
            const legacy = gameVersion < 22 || typeof body.gjp === 'string' ||
                typeof body.password === 'string' && /(?:login|backup|sync|register)GJAccount/.test(original);
            if (!legacy) {
                if (legacyUsers.targets.has(target)) {
                    const send = res.send;
                    res.send = function (value) {
                        res.send = send;
                        try { return send.call(this, legacyUsers.rewrite(api.db, target, value)); }
                        catch (error) { next(error); return this; }
                    };
                }
                return next();
            }
            const state = { target, gameVersion, db: api.db, binaryVersion: Number(body.binaryVersion) || (gameVersion >= 21 ? 35 : 0) };
            // Early clients can have a populated score profile before earning any stars.
            state.includeZeroScores = target === '/getGJScores20.php' && gameVersion < 19 &&
                (body.type == null || body.type === '' || body.type === 'top') &&
                (body.stat == null || body.stat === '' || body.stat === '0');
            context.run(state, () => {
                Promise.resolve().then(async () => {
                    const noAccount = body.accountID == null || body.accountID === '' || body.accountID === '0';
                    // Signed-out clients may still send placeholder GJP fields. PHP ignores
                    // them when accountID is zero; authenticate a guest only by its device.
                    if (gameVersion < 22 && noAccount &&
                        ['/updateGJUserScore22.php', '/uploadGJLevel21.php', '/uploadGJComment21.php', '/deleteGJComment20.php', '/deleteGJLevelUser20.php', '/likeGJItem211.php', '/rateGJStars211.php', '/getGJRewards.php'].includes(target)) {
                        delete body.gjp;
                        delete body.gjp2;
                    }
                    // These original clients send neither credentials nor a secret/device ID.
                    // Keep the exception on their original routes; modern routes retain core checks.
                    const anonymousVote = (gameVersion < 19 &&
                        ['/rateGJLevel.php', '/likeGJLevel.php', '/likeGJItem.php'].includes(original) ||
                        gameVersion < 20 && original === '/rateGJStars.php' ||
                        gameVersion <= 20 && ['/likeGJItem20.php', '/rateGJStars20.php'].includes(original) ||
                        gameVersion === 21 && ['/likeGJItem211.php', '/rateGJStars211.php'].includes(target)) &&
                        (!body.accountID || body.accountID === '0') && !body.gjp && !body.gjp2;
                    if (anonymousVote) {
                        if (['/rateGJLevel.php', '/likeGJLevel.php', '/likeGJItem.php'].includes(original) &&
                            (body.secret == null || body.secret === '')) body.secret = 'Wmfd2893gb7';
                        if (!body.udid && typeof req.ip === 'string' && req.ip) body.udid = `legacy-ip:${req.ip}`;
                    }
                    if (original === '/rateGJLevel.php') {
                        const stars = { 0: '1', 1: '2', 2: '3', 3: '4', 4: '6', 5: '8', 6: '10' };
                        if (typeof body.rating !== 'string' || !Object.hasOwn(stars, body.rating)) return res.type('text/plain').send('-1');
                        body.stars = stars[body.rating];
                    }
                    if (original === '/rateGJStars.php') {
                        if (typeof body.rating !== 'string' || !/^(?:[1-9]|10)$/.test(body.rating)) return res.type('text/plain').send('-1');
                        body.stars = body.rating;
                    }
                    if (['/updateGJUserScore22.php', '/uploadGJLevel21.php', '/uploadGJComment21.php', '/deleteGJComment20.php', '/likeGJItem211.php', '/rateGJStars211.php', '/getGJScores20.php', '/getGJRewards.php'].includes(target) && body.secret !== 'Wmfd2893gb7') {
                        return res.type('text/plain').send('-1');
                    }
                    if (target === '/deleteGJLevelUser20.php' && body.secret !== 'Wmfv2898gc9') return res.type('text/plain').send('-1');
                    if (target === '/getGJRewards.php' && gameVersion < 22 && noAccount) {
                        const rewardType = body.rewardType == null || body.rewardType === '' ? '0' : body.rewardType;
                        if (typeof body.udid !== 'string' || !body.udid || body.udid.length > 256 ||
                            /^\d+$/.test(body.udid) || /[:|~#\0]/.test(body.udid) || !['0', '1', '2'].includes(rewardType) ||
                            typeof body.chk !== 'string' || body.chk.length <= 5 || body.chk.length > 512 ||
                            !/^[A-Za-z0-9_+/-]+={0,2}$/.test(body.chk.slice(5))) return res.type('text/plain').send('-1');
                    }
                    if (anonymousVote && target === '/likeGJItem211.php' && original !== '/likeGJLevel.php') {
                        if (typeof body.udid !== 'string' || !body.udid || body.udid.length > 256) return res.type('text/plain').send('-1');
                        return res.type('text/plain').send(legacyLikes.vote(api.db, hash(body.udid), body) ? '1' : '-1');
                    }
                    if (!body.gjp2) {
                        let password;
                        if (typeof body.gjp === 'string' && body.gjp.length <= 1024) password = xor(decode(body.gjp).toString('binary'), '37526').toString();
                        else if (typeof body.password === 'string' && /(?:login|backup|sync)GJAccount/.test(original)) password = body.password;
                        if (password !== undefined) body.gjp2 = api.utils.generateGJP2(password);
                    }
                    if (target === '/getGJLevels21.php' && body.gauntlet != null && body.gauntlet !== '' && body.gauntlet !== '0') {
                        if (body.secret !== 'Wmfd2893gb7') return res.type('text/plain').send('-1');
                        state.gauntlet = legacyGauntlets.prepare(api.db, body, gameVersion);
                        if (!state.gauntlet) return res.type('text/plain').send('-1');
                    }
                    if (gameVersion < 22 && !noAccount && target === '/likeGJItem211.php' && ['1', '2'].includes(body.type)) {
                        if (typeof body.accountID !== 'string' || !/^[1-9]\d*$/.test(body.accountID)) return res.type('text/plain').send('-1');
                        const accountID = Number(body.accountID);
                        if (!Number.isSafeInteger(accountID)) return res.type('text/plain').send('-1');
                        const account = api.db.prepare('SELECT gjp2, isDisabled FROM accounts WHERE accountID = ?').get(accountID);
                        if (!account || account.isDisabled || account.gjp2 !== body.gjp2) return res.type('text/plain').send('-1');
                        const accepted = legacyLikes.vote(api.db, hash(`legacy-account:${accountID}`), body, accountID);
                        return res.type('text/plain').send(accepted ? '1' : '-1');
                    }
                    // Pre-account clients identify their guest profile using their device ID.
                    // Never use a claimed userID to authenticate a registered account.
                    if (gameVersion < 22 && (!body.accountID || body.accountID === '0') && !body.gjp2 &&
                        typeof body.udid === 'string' && body.udid.length > 0 && body.udid.length <= 256 &&
                        (['/updateGJUserScore22.php', '/uploadGJLevel21.php', '/uploadGJComment21.php', '/deleteGJComment20.php', '/deleteGJLevelUser20.php', '/likeGJItem211.php', '/rateGJStars211.php', '/getGJRewards.php'].includes(target) ||
                         target === '/getGJScores20.php' && ['relative', 'friends'].includes(body.type))) {
                        const deviceHash = hash(body.udid);
                        const guest = api.db.transaction(() => {
                            const mapping = api.db.prepare('SELECT accountID FROM legacy_compat_guests WHERE deviceHash = ?').get(deviceHash);
                            if (mapping) return api.db.prepare('SELECT * FROM accounts WHERE accountID = ?').get(mapping.accountID);
                            if (target === '/deleteGJComment20.php' || target === '/deleteGJLevelUser20.php') return null;
                            const name = `_legacy_${crypto.randomBytes(12).toString('hex')}`;
                            const gjp2 = crypto.randomBytes(20).toString('hex');
                            const maximum = api.db.prepare('SELECT COALESCE(MAX(accountID), 71) AS maximum FROM accounts').get().maximum;
                            const id = Math.max(73, maximum + 1);
                            api.db.prepare('INSERT INTO accounts (accountID, userName, gjp2, isDisabled) VALUES (?, ?, ?, 0)').run(id, name, gjp2);
                            const displayName = api.utils.remove(String(body.userName || 'Player')).slice(0, 20) || 'Player';
                            api.db.prepare('INSERT INTO profiles (accountID, userName) VALUES (?, ?)').run(id, displayName);
                            api.db.prepare('INSERT INTO legacy_compat_guests (deviceHash, accountID) VALUES (?, ?)').run(deviceHash, id);
                            return { accountID: id, userName: name, gjp2, isDisabled: 0 };
                        })();
                        if (!guest || guest.isDisabled) return res.type('text/plain').send('-1');
                        if (target === '/uploadGJComment21.php') state.guestCommentName = body.userName;
                        if (typeof body.userName === 'string' && body.userName.trim()) {
                            const displayName = api.utils.remove(body.userName).slice(0, 20);
                            if (displayName) api.db.prepare('UPDATE profiles SET userName = ? WHERE accountID = ?').run(displayName, guest.accountID);
                        }
                        if (target === '/getGJRewards.php') state.guestRewards = { userID: guest.accountID + 1 };
                        body.accountID = String(guest.accountID);
                        body.gjp2 = guest.gjp2;
                        body.userName = guest.userName;
                    }
                    if (/\/(?:backup|sync)GJAccountNew.php$/.test(target) && !body.accountID && body.userName && body.gjp2) {
                        const account = api.db.prepare('SELECT accountID FROM accounts WHERE LOWER(userName) = ? AND gjp2 = ? AND isDisabled = 0').get(String(body.userName).toLowerCase(), body.gjp2);
                        if (account) body.accountID = String(account.accountID);
                    }
                    if (target === '/accounts/registerGJAccount.php' && !body.rsession) body.rsession = 'legacy';
                    // Classic frS=0 means allow all requests, including text. Core added
                    // a no-text setting at 0 and moved the old behavior to 2. Translate
                    // explicit settings updates only; do not change stored recipient policy.
                    if (target === '/updateGJAccSettings20.php' && binaryVersion < 49 && body.frS === '0') body.frS = '2';
                    if (target === '/deleteGJAccComment20.php' && !body.targetAccountID) body.targetAccountID = body.accountID;
                    if (target === '/getGJUserInfo20.php' && body.accountID && body.accountID === body.targetAccountID && body.gjp2) {
                        const account = api.db.prepare('SELECT gjp2, isDisabled FROM accounts WHERE accountID = ?').get(body.accountID);
                        if (account && account.gjp2 === body.gjp2 && !account.isDisabled) {
                            state.messageCount = api.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE toAccountID = ? AND isNew = 1').get(body.accountID).count;
                        }
                    }
                    if (original.includes('getGJCreators')) body.type = 'creators';
                    if (original === '/likeGJLevel.php') { body.itemID = body.levelID; body.type = '1'; body.like = '1'; }
                    if (original === '/reportGJLevel.php') { body.targetID = body.levelID; body.type = '1'; body.reasons = '0'; }
                    if (target.endsWith('/backupGJAccountNew.php')) {
                        body.gameVersion ||= String(gameVersion);
                        body.binaryVersion ||= String(state.binaryVersion || 1);
                        body.udid ||= 'legacy';
                        body.uuid ||= 'legacy';
                    }
                    if (target === '/updateGJUserScore22.php' && body.accountID && body.gjp2) {
                        const account = api.db.prepare('SELECT gjp2, isDisabled FROM accounts WHERE accountID = ?').get(body.accountID);
                        if (account && account.gjp2 === body.gjp2 && !account.isDisabled) {
                            const profile = api.db.prepare('SELECT * FROM profiles WHERE accountID = ?').get(body.accountID);
                            // Old clients must not erase statistics/icons introduced by later releases.
                            const fields = 'stars demons icon color1 color2 coins iconType userCoins special accIcon accShip accBall accBird accDart accRobot accGlow accSpider accExplosion accSwing accJetpack diamonds moons color3';
                            for (const field of fields.split(' ')) if (profile && body[field] == null) body[field] = String(profile[field] ?? 0);
                            // The core recalculates these from lists of completed IDs; preserve the stored summaries with a query hook below.
                            state.profile = profile;
                            body.dinfo = '';
                            body.sinfo = '';
                        }
                    }
                    if (target === '/uploadGJLevel21.php') {
                        body.gameVersion = String(gameVersion);
                        if (body.password == null || body.password === '') body.password = gameVersion <= 17 ? '1' : '0';
                        for (const field of 'levelID levelVersion levelLength audioTrack auto original twoPlayer songID objects coins requestedStars unlisted ldm wt wt2 ts'.split(' ')) {
                            if (body[field] == null || body[field] === '') body[field] = field === 'levelVersion' ? '1' : '0';
                        }
                        if (gameVersion < 20) body.levelDesc = encode(String(body.levelDesc || ''));
                        const source = String(body.levelString || '');
                        const raw = gameVersion <= 18 && /[,;]/.test(source) ? Buffer.from(source) : await unzip(decode(source), { maxOutputLength: MAX_BYTES });
                        body.levelString = encode(await gzip(raw));
                        const step = Math.floor(body.levelString.length / 50);
                        const seed = body.levelString.length < 50 ? body.levelString : hash(Array.from({ length: 50 }, (_, i) => body.levelString[i * step]).join('') + 'xI25fpAapCQg');
                        body.seed2 = body.levelString.length < 50 ? seed : xor(seed, '41274').toString('base64');
                    }
                    if (target === '/uploadGJComment21.php' && (gameVersion < 21 || state.guestCommentName !== undefined)) {
                        if (gameVersion < 20) body.comment = encode(String(body.comment || ''));
                        body.percent ??= '0';
                        if (gameVersion < 21) body.cType = '0';
                        const cType = Number(body.cType || 0);
                        const checksum = name => encode(xor(hash(`${name}${body.comment}${Number(body.levelID)}${Number(body.percent)}${cType}xPT6iUrtws0J`), '29481'));
                        if (gameVersion >= 21 && body.chk !== checksum(state.guestCommentName)) return res.type('text/plain').send('-1');
                        body.chk = checksum(body.userName);
                    }
                    // Rewrite internally: POST bodies/credentials never enter a redirect URL.
                    if (target !== original) req.url = target + req.url.slice(original.length);
                    const send = res.send;
                    res.send = function (value) {
                        res.send = send;
                        responseFor(value, state).then(result => send.call(res, result)).catch(next);
                        return res;
                    };
                    next();
                }).catch(next);
            });
        });
        api.registerHook('database:query', request => {
            const state = context.getStore();
            if (state?.gameVersion < 22 && request.method === 'all' &&
                (state.target === '/getGJMapPacks21.php' && /FROM mapPacks\b/i.test(request.sql) ||
                 state.target === '/getGJGauntlets21.php' && /FROM gauntlets\b/i.test(request.sql))) {
                request.result = request.execute().filter(item => {
                    const ids = state.target === '/getGJMapPacks21.php' ? String(item.levels).split(',') : [1, 2, 3, 4, 5].map(i => item[`level${i}`]);
                    return ids.length > 0 && ids.every(id => {
                        const level = api.db.prepare('SELECT gameVersion, levelLength FROM levels WHERE levelID = ?').get(id);
                        return level && level.gameVersion <= state.gameVersion && level.levelLength !== 5;
                    });
                });
                request.handled = true;
            }
            if (state?.profile && request.method === 'run' && /UPDATE profiles SET\s+coins =/i.test(request.sql)) {
                const columns = request.sql.split(/SET/i)[1].split(/WHERE/i)[0].split(',').map(s => s.trim().split(/\s*=/)[0]);
                for (const name of ['dinfo', 'sinfo', 'pinfo']) {
                    const index = columns.indexOf(name);
                    if (index >= 0) request.params[index] = state.profile[name] || '';
                }
            }
            return request;
        });
        for (const name of ['get', 'download', 'upload', 'delete']) {
            const endpoint = require(`./messages/${name}GJMessage${name === 'get' || name === 'delete' ? 's' : ''}20`);
            api.addEndpoint({ ...endpoint, handler(req, res, next) {
                if ((name === 'get' || name === 'download') && !context.getStore()) return next();
                req.legacyMessageBridge = messageBridge;
                return endpoint.handler(req, res, next);
            } });
        }
    }
};
