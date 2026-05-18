const Database = require("better-sqlite3");

function ensureColumn(db, tableName, columnName, definition) {
	const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
	if (columns.some((column) => column.name === columnName)) {
		return;
	}

	db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function createDatabase(dbPath) {
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");

	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			telegram_id TEXT NOT NULL UNIQUE,
			username TEXT,
			first_name TEXT,
			last_name TEXT,
			settings_json TEXT NOT NULL DEFAULT '{}',
			is_blocked INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS user_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			direction TEXT NOT NULL,
			message_type TEXT NOT NULL,
			text TEXT,
			payload_json TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY(user_id) REFERENCES users(id)
		);

		CREATE TABLE IF NOT EXISTS admin_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_type TEXT NOT NULL,
			payload_json TEXT,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS subscription_reminders (
			user_id INTEGER NOT NULL,
			subscription_id TEXT NOT NULL,
			last_sent_at TEXT NOT NULL,
			PRIMARY KEY (user_id, subscription_id),
			FOREIGN KEY(user_id) REFERENCES users(id)
		);

		CREATE TABLE IF NOT EXISTS web_users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			settings_json TEXT NOT NULL DEFAULT '{}',
			linked_telegram_user_id INTEGER,
			link_code TEXT,
			link_code_expires_at TEXT,
			created_at TEXT NOT NULL,
			last_login_at TEXT NOT NULL,
			FOREIGN KEY(linked_telegram_user_id) REFERENCES users(id)
		);

		CREATE TABLE IF NOT EXISTS event_snapshots (
			anarchy TEXT PRIMARY KEY,
			summary_text TEXT NOT NULL DEFAULT '',
			raw_lines_json TEXT,
			updated_at TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'bot'
		);

		CREATE TABLE IF NOT EXISTS site_login_requests (
			code TEXT PRIMARY KEY,
			status TEXT NOT NULL DEFAULT 'pending',
			resolved_web_user_id INTEGER,
			resolved_telegram_user_id TEXT,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			completed_at TEXT,
			FOREIGN KEY(resolved_web_user_id) REFERENCES web_users(id)
		);
	`);

	ensureColumn(db, "users", "block_reason", "TEXT NOT NULL DEFAULT ''");
	ensureColumn(db, "web_users", "settings_json", "TEXT NOT NULL DEFAULT '{}'");
	ensureColumn(db, "web_users", "linked_telegram_user_id", "INTEGER");
	ensureColumn(db, "web_users", "link_code", "TEXT");
	ensureColumn(db, "web_users", "link_code_expires_at", "TEXT");

	return db;
}

module.exports = {
	createDatabase
};
