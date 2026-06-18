/**
 * SQLite 数据库模块
 * 提供账号、角色、皮肤、道具、称号等数据的持久化存储
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './config';

let db: Database.Database | null = null;

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT DEFAULT '',
  nickname TEXT NOT NULL DEFAULT 'Player',
  avatar_id INTEGER DEFAULT 400101,
  avatar_frame INTEGER DEFAULT 200001,
  title INTEGER DEFAULT 600001,
  vip INTEGER DEFAULT 0,
  gold INTEGER DEFAULT 0,
  diamond INTEGER DEFAULT 0,
  skin_ticket INTEGER DEFAULT 0,
  level_id INTEGER DEFAULT 1001,
  level_score INTEGER DEFAULT 0,
  level3_id INTEGER DEFAULT 1001,
  level3_score INTEGER DEFAULT 0,
  signature TEXT DEFAULT '',
  birthday INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  login_time INTEGER DEFAULT 0,
  logout_time INTEGER DEFAULT 0,
  signup_time INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS account_characters (
  account_id INTEGER NOT NULL,
  charid INTEGER NOT NULL,
  level INTEGER DEFAULT 1,
  exp INTEGER DEFAULT 0,
  skin INTEGER DEFAULT 0,
  is_upgraded INTEGER DEFAULT 0,
  extra_emoji TEXT DEFAULT '[]',
  rewarded_level TEXT DEFAULT '[]',
  PRIMARY KEY (account_id, charid),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS account_skins (
  account_id INTEGER NOT NULL,
  skin_id INTEGER NOT NULL,
  PRIMARY KEY (account_id, skin_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS account_items (
  account_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, item_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS account_titles (
  account_id INTEGER NOT NULL,
  title_id INTEGER NOT NULL,
  PRIMARY KEY (account_id, title_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS game_records (
  uuid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS server_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
CREATE INDEX IF NOT EXISTS idx_account_characters_account ON account_characters(account_id);
CREATE INDEX IF NOT EXISTS idx_account_skins_account ON account_skins(account_id);
CREATE INDEX IF NOT EXISTS idx_account_items_account ON account_items(account_id);
CREATE INDEX IF NOT EXISTS idx_account_titles_account ON account_titles(account_id);
`;

export interface AccountRow {
  id: number;
  username: string;
  password: string;
  nickname: string;
  avatar_id: number;
  avatar_frame: number;
  title: number;
  vip: number;
  gold: number;
  diamond: number;
  skin_ticket: number;
  level_id: number;
  level_score: number;
  level3_id: number;
  level3_score: number;
  signature: string;
  birthday: number;
  verified: number;
  login_time: number;
  logout_time: number;
  signup_time: number;
}

export interface CharacterRow {
  account_id: number;
  charid: number;
  level: number;
  exp: number;
  skin: number;
  is_upgraded: number;
  extra_emoji: string;
  rewarded_level: string;
}

export interface SkinRow {
  account_id: number;
  skin_id: number;
}

export interface ItemRow {
  account_id: number;
  item_id: number;
  count: number;
}

export interface TitleRow {
  account_id: number;
  title_id: number;
}

export function initDatabase(): Database.Database {
  const config = getConfig();
  const dbPath = path.resolve(process.cwd(), config.database.path);

  // Ensure data directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Initialize schema - create schema_version table first
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `);

  const currentVersion = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  if (!currentVersion) {
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    console.log(`[database] Initialized schema version ${SCHEMA_VERSION}`);
  }

  // Migrate from old accounts.json if exists
  migrateFromJson();

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============ Account Operations ============

export function findAccountByUsername(username: string): AccountRow | undefined {
  return getDb().prepare('SELECT * FROM accounts WHERE username = ?').get(username) as AccountRow | undefined;
}

export function findAccountById(id: number): AccountRow | undefined {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
}

export function createAccount(username: string, password: string, nickname: string): AccountRow {
  const config = getConfig();
  const now = Math.floor(Date.now() / 1000);

  const result = getDb().prepare(`
    INSERT INTO accounts (username, password, nickname, vip, gold, diamond, skin_ticket, verified, signup_time, login_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(username, password, nickname, config.game.init_vip, config.game.init_gold, config.game.init_diamond, config.game.init_skin_ticket, now, now);

  const accountId = result.lastInsertRowid as number;

  // Unlock all game content based on config
  unlockAllContent(accountId);

  return findAccountById(accountId)!;
}

export function updateAccountLogin(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare('UPDATE accounts SET login_time = ? WHERE id = ?').run(now, id);
}

export function updateAccountField(id: number, field: string, value: any): void {
  const allowedFields = ['nickname', 'avatar_id', 'avatar_frame', 'title', 'signature', 'birthday', 'gold', 'diamond', 'skin_ticket', 'level_id', 'level_score', 'level3_id', 'level3_score', 'vip', 'verified'];
  if (!allowedFields.includes(field)) {
    throw new Error(`Invalid account field: ${field}`);
  }
  getDb().prepare(`UPDATE accounts SET ${field} = ? WHERE id = ?`).run(value, id);
}

// ============ Character Operations ============

export function getAccountCharacters(accountId: number): CharacterRow[] {
  return getDb().prepare('SELECT * FROM account_characters WHERE account_id = ?').all(accountId) as CharacterRow[];
}

export function addAccountCharacter(accountId: number, charid: number, level: number = 1, skin: number = 0, isUpgraded: number = 0): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO account_characters (account_id, charid, level, exp, skin, is_upgraded, extra_emoji, rewarded_level)
    VALUES (?, ?, ?, 0, ?, ?, '[]', '[]')
  `).run(accountId, charid, level, skin, isUpgraded);
}

// ============ Skin Operations ============

export function getAccountSkins(accountId: number): SkinRow[] {
  return getDb().prepare('SELECT * FROM account_skins WHERE account_id = ?').all(accountId) as SkinRow[];
}

export function addAccountSkin(accountId: number, skinId: number): void {
  getDb().prepare('INSERT OR IGNORE INTO account_skins (account_id, skin_id) VALUES (?, ?)').run(accountId, skinId);
}

// ============ Item Operations ============

export function getAccountItems(accountId: number): ItemRow[] {
  return getDb().prepare('SELECT * FROM account_items WHERE account_id = ?').all(accountId) as ItemRow[];
}

export function addAccountItem(accountId: number, itemId: number, count: number = 1): void {
  getDb().prepare(`
    INSERT INTO account_items (account_id, item_id, count) VALUES (?, ?, ?)
    ON CONFLICT(account_id, item_id) DO UPDATE SET count = count + ?
  `).run(accountId, itemId, count, count);
}

// ============ Title Operations ============

export function getAccountTitles(accountId: number): TitleRow[] {
  return getDb().prepare('SELECT * FROM account_titles WHERE account_id = ?').all(accountId) as TitleRow[];
}

export function addAccountTitle(accountId: number, titleId: number): void {
  getDb().prepare('INSERT OR IGNORE INTO account_titles (account_id, title_id) VALUES (?, ?)').run(accountId, titleId);
}

// ============ Game Records ============

export function saveGameRecord(uuid: string, data: string): void {
  getDb().prepare('INSERT OR REPLACE INTO game_records (uuid, data) VALUES (?, ?)').run(uuid, data);
}

export function getGameRecord(uuid: string): string | undefined {
  const row = getDb().prepare('SELECT data FROM game_records WHERE uuid = ?').get(uuid) as { data: string } | undefined;
  return row?.data;
}

export function getRecentGameRecords(limit: number = 100): { uuid: string; data: string; created_at: number }[] {
  return getDb().prepare('SELECT * FROM game_records ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
}

// ============ Unlock All Content ============

function unlockAllContent(accountId: number): void {
  const config = getConfig();
  const gameData = require('./game-data').getGameData();

  const insertChars = getDb().prepare(`
    INSERT OR IGNORE INTO account_characters (account_id, charid, level, exp, skin, is_upgraded, extra_emoji, rewarded_level)
    VALUES (?, ?, ?, 10000, ?, 1, '[]', '[]')
  `);

  const insertSkins = getDb().prepare('INSERT OR IGNORE INTO account_skins (account_id, skin_id) VALUES (?, ?)');
  const insertItems = getDb().prepare('INSERT OR IGNORE INTO account_items (account_id, item_id, count) VALUES (?, ?, ?)');
  const insertTitles = getDb().prepare('INSERT OR IGNORE INTO account_titles (account_id, title_id) VALUES (?, ?)');

  const transaction = getDb().transaction(() => {
    // Unlock all characters
    if (config.game.unlock_all_characters && gameData.characters) {
      for (const char of gameData.characters) {
        const initSkin = char.init_skin || 0;
        insertChars.run(accountId, char.id, config.game.init_character_level, initSkin);
      }
    }

    // Unlock all skins
    if (config.game.unlock_all_skins && gameData.skins) {
      for (const skin of gameData.skins) {
        insertSkins.run(accountId, skin.id);
      }
    }

    // Unlock all items (give 999 of each)
    if (config.game.unlock_all_items && gameData.items) {
      for (const item of gameData.items) {
        insertItems.run(accountId, item.id, 999);
      }
    }

    // Unlock all titles
    if (config.game.unlock_all_titles && gameData.titles) {
      for (const title of gameData.titles) {
        insertTitles.run(accountId, title.id);
      }
    }
  });

  transaction();
}

// ============ Migration from JSON ============

function migrateFromJson(): void {
  const accountsJsonPath = path.resolve(process.cwd(), 'data', 'accounts.json');
  if (!fs.existsSync(accountsJsonPath)) return;

  try {
    const data = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
    if (typeof data !== 'object' || data === null) return;

    // Check if accounts table is empty
    const count = (getDb().prepare('SELECT COUNT(*) as c FROM accounts').get() as any).c;
    if (count > 0) return;

    console.log('[database] Migrating accounts from accounts.json...');
    const insert = getDb().prepare(`
      INSERT OR IGNORE INTO accounts (id, username, password, nickname, gold, diamond, vip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = getDb().transaction(() => {
      for (const [key, account] of Object.entries(data)) {
        const acc = account as any;
        insert.run(acc.id || 10001, key, acc.password || '', acc.nickname || 'Player', acc.gold || 0, acc.diamond || 0, acc.vip || 0);
      }
    });
    transaction();

    console.log(`[database] Migrated ${Object.keys(data).length} accounts from JSON`);
    // Rename old file
    fs.renameSync(accountsJsonPath, accountsJsonPath + '.bak');
  } catch (e) {
    console.warn('[database] Failed to migrate from accounts.json:', e);
  }
}
