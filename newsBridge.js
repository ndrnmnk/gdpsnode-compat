'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = function newsBridge(api, legacy, options = {}) {
    const db = api.db;
    const staticNewsPath = options.staticNewsPath || path.resolve(__dirname, '../../endpoints/content/news/news.dat');
    db.exec(`CREATE TABLE IF NOT EXISTS legacy_compat_news_subscribers (accountID INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS legacy_compat_news_seen (newsID INTEGER PRIMARY KEY)`);
    // Start with the currently published feed: enabling/restarting the plugin is not a publication.
    db.prepare('INSERT OR IGNORE INTO legacy_compat_news_seen (newsID) SELECT newsID FROM dashboard_news').run();

    function command(accountID, text) {
        if (/^subscribe_news$/i.test(text.trim())) {
            db.prepare('INSERT OR IGNORE INTO legacy_compat_news_subscribers (accountID) VALUES (?)').run(accountID);
            return 'Subscribed to news. Future local articles will arrive as legacy messages. Send unsubscribe_news to stop.';
        }
        if (/^unsubscribe_news$/i.test(text.trim())) {
            db.prepare('DELETE FROM legacy_compat_news_subscribers WHERE accountID = ?').run(accountID);
            return 'Unsubscribed from news.';
        }
        return null;
    }
    api.registerHook('database:query', query => {
        if (query.method !== 'run' || query.handled || !/^\s*UPDATE\s+dashboard_news_settings\s+SET\s+version\s*=/i.test(query.sql)) return query;
        query.handled = true;
        query.result = db.transaction(() => {
            const result = query.execute();
            if (!result.changes) return result;
            // Dashboard saves replace the whole list before bumping its version.
            const latest = db.prepare('SELECT * FROM dashboard_news ORDER BY newsID DESC LIMIT 1').get();
            const unseen = latest && !db.prepare('SELECT 1 FROM legacy_compat_news_seen WHERE newsID = ?').get(latest.newsID);
            db.prepare('INSERT OR IGNORE INTO legacy_compat_news_seen (newsID) SELECT newsID FROM dashboard_news').run();
            // A static news.dat takes precedence over dashboard news in server.js.
            // Official redirects/static copies are never fetched or imported by this bridge.
            if (!unseen || fs.existsSync(staticNewsPath)) return result;
            const subscribers = db.prepare(`SELECT s.accountID FROM legacy_compat_news_subscribers s
                JOIN accounts a ON a.accountID = s.accountID WHERE a.isDisabled = 0`).all();
            let text = `${latest.title}\n${latest.publishDate}\n\n${latest.body}`;
            if (latest.buttonLabel) text += `\n\n${latest.buttonLabel}: ${latest.buttonUrl}`;
            const footer = latest.imageFile ? `[Image attached: ${latest.imageFile}]` : '';
            for (const subscriber of subscribers) legacy(71, 'GDPSnode Notifications', subscriber.accountID, `News: ${latest.title}`, text, footer);
            return result;
        })();
        return query;
    });
    return { command };
};
