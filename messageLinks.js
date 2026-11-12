'use strict';

module.exports = function messageLinks(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS legacy_compat_message_links (
            legacyID INTEGER PRIMARY KEY,
            messageID INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS legacy_compat_message_links_thread
            ON legacy_compat_message_links (messageID);
        CREATE TRIGGER IF NOT EXISTS legacy_compat_delete_legacy_message
        AFTER DELETE ON messages
        WHEN EXISTS (SELECT 1 FROM legacy_compat_message_links WHERE legacyID = OLD.ID)
        BEGIN
            DELETE FROM thread_messages WHERE messageID IN (
                SELECT messageID FROM legacy_compat_message_links WHERE legacyID = OLD.ID
            );
            DELETE FROM legacy_compat_message_links WHERE legacyID = OLD.ID;
        END;
        CREATE TRIGGER IF NOT EXISTS legacy_compat_delete_thread_message
        AFTER DELETE ON thread_messages
        WHEN EXISTS (SELECT 1 FROM legacy_compat_message_links WHERE messageID = OLD.messageID)
        BEGIN
            DELETE FROM messages WHERE ID IN (
                SELECT legacyID FROM legacy_compat_message_links WHERE messageID = OLD.messageID
            );
            DELETE FROM legacy_compat_message_links WHERE messageID = OLD.messageID;
            UPDATE threads SET mv = mv + 1 WHERE threadID = OLD.threadID;
        END;
    `);
    return function link(messageID, legacyIDs) {
        for (const legacyID of legacyIDs) {
            db.prepare('INSERT INTO legacy_compat_message_links (legacyID, messageID) VALUES (?, ?)')
                .run(legacyID, messageID);
        }
    };
};
