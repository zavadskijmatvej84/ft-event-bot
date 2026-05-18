const { loadConfig } = require("./config");
const { restoreSqliteFromRemote } = require("./sqlite-remote-backup");

async function main() {
	const config = loadConfig();
	const remoteUrl = String(config.databaseBackupUrl || "").trim();

	if (remoteUrl) {
		try {
			await restoreSqliteFromRemote({
				dbPath: config.dbPath,
				connectionString: remoteUrl,
				backupKey: config.databaseBackupKey,
				logger: console
			});
		} catch (error) {
			console.error("Remote restore skipped:", error.message);
		}
	}

	require("./app");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
