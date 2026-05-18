const fs = require("fs");
const path = require("path");

const DEFAULT_BACKUP_KEY = "telegram-center";
const WRITE_SQL_PATTERN = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;

function ensureParentDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function removeIfExists(filePath) {
	if (fs.existsSync(filePath)) {
		fs.rmSync(filePath, { force: true });
	}
}

async function withClient(connectionString, task) {
	const { Client } = require("pg");
	const client = new Client({
		connectionString,
		ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
			? false
			: { rejectUnauthorized: false }
	});
	await client.connect();
	try {
		return await task(client);
	} finally {
		await client.end().catch(() => {});
	}
}

async function ensureRemoteTable(client) {
	await client.query(`
		CREATE TABLE IF NOT EXISTS sqlite_backups (
			backup_key TEXT PRIMARY KEY,
			payload BYTEA NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`);
}

async function restoreSqliteFromRemote({ dbPath, connectionString, backupKey = DEFAULT_BACKUP_KEY, logger = console }) {
	if (!connectionString) {
		return false;
	}

	return withClient(connectionString, async (client) => {
		await ensureRemoteTable(client);
		const result = await client.query(
			"SELECT payload FROM sqlite_backups WHERE backup_key = $1 LIMIT 1",
			[backupKey]
		);

		if (!result.rows.length) {
			logger.log("Remote SQLite backup not found yet.");
			return false;
		}

		ensureParentDir(dbPath);
		removeIfExists(dbPath);
		removeIfExists(`${dbPath}-wal`);
		removeIfExists(`${dbPath}-shm`);
		fs.writeFileSync(dbPath, result.rows[0].payload);
		logger.log("SQLite database restored from remote backup.");
		return true;
	});
}

function attachRemoteSqliteBackup(db, {
	dbPath,
	connectionString,
	backupKey = DEFAULT_BACKUP_KEY,
	logger = console,
	debounceMs = 2500
} = {}) {
	if (!connectionString) {
		return {
			enabled: false,
			flushNow: async () => {}
		};
	}

	let timer = null;
	let running = false;
	let pending = false;

	async function flushNow() {
		if (running) {
			pending = true;
			return;
		}

		running = true;
		try {
			db.pragma("wal_checkpoint(TRUNCATE)");
			ensureParentDir(dbPath);
			const payload = fs.readFileSync(dbPath);
			await withClient(connectionString, async (client) => {
				await ensureRemoteTable(client);
				await client.query(`
					INSERT INTO sqlite_backups (backup_key, payload, updated_at)
					VALUES ($1, $2, NOW())
					ON CONFLICT (backup_key) DO UPDATE SET
						payload = EXCLUDED.payload,
						updated_at = NOW()
				`, [backupKey, payload]);
			});
			logger.log("SQLite backup uploaded to remote storage.");
		} catch (error) {
			logger.error("Remote SQLite backup failed:", error.message);
		} finally {
			running = false;
			if (pending) {
				pending = false;
				scheduleFlush();
			}
		}
	}

	function scheduleFlush() {
		if (timer) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => {
			timer = null;
			flushNow().catch(() => {});
		}, debounceMs);
	}

	const originalPrepare = db.prepare.bind(db);
	db.prepare = function patchedPrepare(sql) {
		const statement = originalPrepare(sql);
		if (!WRITE_SQL_PATTERN.test(String(sql || ""))) {
			return statement;
		}

		const originalRun = statement.run.bind(statement);
		statement.run = function patchedRun(...args) {
			const result = originalRun(...args);
			scheduleFlush();
			return result;
		};

		return statement;
	};

	process.once("SIGINT", () => {
		flushNow().catch(() => {});
	});
	process.once("SIGTERM", () => {
		flushNow().catch(() => {});
	});

	scheduleFlush();

	return {
		enabled: true,
		flushNow
	};
}

module.exports = {
	restoreSqliteFromRemote,
	attachRemoteSqliteBackup
};
