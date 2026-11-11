'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const filename = path.resolve(__dirname, '../index.js');
const localRequire = createRequire(filename);

function install(options = {}) {
    const config = { ...require('../config.js'), ...options };
    const middleware = [];
    const warnings = [];
    let bridges = 0;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, Buffer,
        console: { warn: warning => warnings.push(warning) },
        require(name) {
            if (name === './config.js') return config;
            if (name === './messageBridge') return api => {
                bridges++;
                api.use((req, res) => res.send('bridge'));
                return {};
            };
            if (name === './legacyLikes') return { initialize() {} };
            if (name.startsWith('./messages/')) return { handler() {} };
            return localRequire(name);
        }
    }, { filename });
    module.exports.install({ db: { exec() {} }, use: fn => middleware.push(fn), registerHook() {}, addEndpoint() {} });
    async function request(url, body = {}, method = 'POST') {
        const req = { method, path: url, url, body, query: body, secure: false };
        return new Promise((resolve, reject) => {
            const res = { type() { return this; }, send(value) { resolve(value); return this; } };
            let index = 0;
            function next(error) {
                if (error) return reject(error);
                const handler = middleware[index++];
                if (!handler) return resolve(undefined);
                try { Promise.resolve(handler(req, res, next)).catch(reject); }
                catch (error) { reject(error); }
            }
            next();
        });
    }
    return { request, warnings, bridges };
}

test('minimum binary version rejects before bridge middleware, including modern and GET requests', async () => {
    const { request } = install({ min_binary_version: 35 });
    for (const route of ['/getGJLevels21.php', '/sendGJThreadMessage.php', '/anything']) {
        for (const binaryVersion of ['34', undefined, 'invalid']) {
            assert.equal(await request(route, { gameVersion: '22', binaryVersion }), '-1');
        }
        assert.equal(await request(route, { binaryVersion: '35' }), 'bridge');
        assert.equal(await request(route, { binaryVersion: '47' }), 'bridge');
    }
    assert.equal(await request('/getGJLevels21.php', { binaryVersion: '34' }, 'GET'), '-1');
    assert.equal(await install().request('/anything'), 'bridge');
});

test('insecure login controls HTTP password requests and prints a red startup warning', async () => {
    const secure = install({ allow_message_bridge: false });
    assert.equal(secure.warnings.length, 0);
    assert.equal(await secure.request('/accounts/loginGJAccount.php', { password: 'secret', gameVersion: '22' }), '-1');
    const insecure = install({ allow_message_bridge: false, allow_insecure_login: true });
    assert.equal(insecure.warnings.length, 1);
    assert.match(insecure.warnings[0], /\x1b\[1;31m.*allow_insecure_login.*\x1b\[0m/);
    // The HTTP password request reaches the endpoint when explicitly enabled.
    assert.equal(await insecure.request('/accounts/registerGJAccount.php', { password: 'secret', gameVersion: '22', gjp2: 'hash' }), undefined);
});

test('disabled guest action options reject original and current aliases', async () => {
    for (const [option, routes] of [
        ['allow_1.0_likes', ['/likeGJLevel.php']],
        ['allow_unregistered_level_uploads', ['/uploadGJLevel.php', '/uploadGJLevel21.php']],
        ['allow_unregistered_comments', ['/uploadGJComment.php', '/uploadGJComment21.php']],
        ['allow_unregistered_likes', ['/likeGJLevel.php', '/likeGJItem20.php', '/likeGJItem211.php']],
        ['allow_unregistered_rates', ['/rateGJLevel.php', '/rateGJStars20.php', '/rateGJStars211.php']]
    ]) {
        const { request } = install({ allow_message_bridge: false, [option]: false });
        for (const route of routes) {
            assert.equal(await request(route, { gameVersion: '21', accountID: '0', gjp: '0' }), '-1', `${option}: ${route}`);
        }
        if (option !== 'allow_1.0_likes') {
            assert.equal(await request(routes.at(-1), { gameVersion: '22', accountID: '72', gjp2: 'hash' }), undefined);
        }
    }
});

test('message bridge is installed only when enabled', () => {
    assert.equal(install().bridges, 1);
    assert.equal(install({ allow_message_bridge: false }).bridges, 0);
});
