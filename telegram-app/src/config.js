const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, "data");
const CONFIG_DIR = process.env.CONFIG_DIR ? path.resolve(process.env.CONFIG_DIR) : path.join(ROOT_DIR, "config");
const CONFIG_PATH = process.env.CONFIG_PATH ? path.resolve(process.env.CONFIG_PATH) : path.join(CONFIG_DIR, "runtime-config.json");
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, "telegram-center.sqlite");

function ensureDir(dirPath) {
	fs.mkdirSync(dirPath, { recursive: true });
}

function ensureEnvironment() {
	ensureDir(DATA_DIR);
	ensureDir(CONFIG_DIR);
}

function scoreTextReadability(text) {
	let score = 0;

	for (const char of String(text || "")) {
		if (/[А-Яа-яЁё]/.test(char)) {
			score += 3;
		} else if (/[A-Za-z0-9]/.test(char)) {
			score += 2;
		} else if (/\s/.test(char)) {
			score += 1;
		} else if (/[[\]():;,.!@#%&*+\-_=/?<>|«»]/.test(char)) {
			score += 0.5;
		} else if (/[ЃѓЉљЊњЋћЏџ�]/.test(char)) {
			score -= 4;
		} else {
			score -= 1;
		}
	}

	return score;
}

function decodeMaybeMojibake(value) {
	let text = String(value ?? "");
	if (!text) {
		return "";
	}

	for (let attempt = 0; attempt < 2; attempt += 1) {
		let candidate = text;
		try {
			candidate = iconv.decode(iconv.encode(text, "win1251"), "utf8");
		} catch {
			return text;
		}

		if (scoreTextReadability(candidate) <= scoreTextReadability(text)) {
			break;
		}

		text = candidate;
	}

	return text.trim();
}

function normalizeReminderInterval(value) {
	const normalized = String(value || "none").trim().toLowerCase();
	if (["minute", "hour", "day"].includes(normalized)) {
		return normalized;
	}

	return "none";
}

function normalizeRequiredSubscriptions(requiredSubscriptions) {
	const normalized = (requiredSubscriptions || []).map((item) => ({
		id: String(item.id || "").trim(),
		title: decodeMaybeMojibake(item.title || ""),
		url: String(item.url || "").trim(),
		username: String(item.username || "").trim(),
		enabled: item.enabled !== false,
		reminderInterval: normalizeReminderInterval(item.reminderInterval)
	})).filter((item) => item.id && item.url);

	const unique = [];
	const seen = new Set();
	for (const item of normalized) {
		const key = `${item.username.toLowerCase()}|${item.url.toLowerCase()}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		unique.push(item);
	}

	return unique;
}

function normalizeSnapshotSourceMode(value) {
	const normalized = String(value || "auto").trim().toLowerCase();
	if (["auto", "log", "push"].includes(normalized)) {
		return normalized;
	}

	return "auto";
}

function buildDefaultConfig() {
	return {
		botToken: "",
		panelPort: 3080,
		panelHost: "127.0.0.1",
		adminUsername: "admin",
		adminPassword: "change_me_please",
		checkerLogPath: path.join(ROOT_DIR, "..", "run", "logs", "latest.log"),
		timeZone: "Europe/Moscow",
		snapshotSourceMode: "auto",
		eventIngestToken: crypto.randomBytes(18).toString("hex"),
		requiredSubscriptions: [],
		knownEvents: []
	};
}

function loadConfig() {
	ensureEnvironment();

	const defaults = buildDefaultConfig();
	let config = {};
	if (fs.existsSync(CONFIG_PATH)) {
		const rawText = fs.readFileSync(CONFIG_PATH, "utf8");
		config = JSON.parse(rawText);
	} else {
		config = defaults;
		saveConfig(config);
	}

	const mergedConfig = {
		...defaults,
		...config
	};

	const envOverrides = {
		botToken: process.env.BOT_TOKEN || mergedConfig.botToken,
		panelPort: Number(process.env.PANEL_PORT || process.env.PORT || mergedConfig.panelPort),
		panelHost: process.env.PANEL_HOST || (process.env.RENDER ? "0.0.0.0" : mergedConfig.panelHost),
		adminUsername: process.env.ADMIN_USERNAME || mergedConfig.adminUsername,
		adminPassword: process.env.ADMIN_PASSWORD || mergedConfig.adminPassword,
		checkerLogPath: process.env.CHECKER_LOG_PATH || mergedConfig.checkerLogPath,
		timeZone: process.env.TIME_ZONE || mergedConfig.timeZone,
		snapshotSourceMode: process.env.SNAPSHOT_SOURCE_MODE || mergedConfig.snapshotSourceMode,
		eventIngestToken: process.env.EVENT_INGEST_TOKEN || mergedConfig.eventIngestToken
	};

	return {
		...mergedConfig,
		...envOverrides,
		snapshotSourceMode: normalizeSnapshotSourceMode(envOverrides.snapshotSourceMode),
		eventIngestToken: String(envOverrides.eventIngestToken || "").trim(),
		requiredSubscriptions: normalizeRequiredSubscriptions(mergedConfig.requiredSubscriptions),
		knownEvents: (mergedConfig.knownEvents || []).map((item) => decodeMaybeMojibake(item)).filter(Boolean),
		rootDir: ROOT_DIR,
		dataDir: DATA_DIR,
		configDir: CONFIG_DIR,
		configPath: CONFIG_PATH,
		dbPath: DB_PATH
	};
}

function saveConfig(config) {
	ensureEnvironment();
	const serializable = {
		botToken: config.botToken,
		panelPort: config.panelPort,
		panelHost: config.panelHost,
		adminUsername: config.adminUsername,
		adminPassword: config.adminPassword,
		checkerLogPath: config.checkerLogPath,
		timeZone: config.timeZone,
		snapshotSourceMode: normalizeSnapshotSourceMode(config.snapshotSourceMode),
		eventIngestToken: String(config.eventIngestToken || "").trim(),
		requiredSubscriptions: normalizeRequiredSubscriptions(config.requiredSubscriptions),
		knownEvents: (config.knownEvents || []).map((item) => decodeMaybeMojibake(item)).filter(Boolean)
	};

	fs.writeFileSync(CONFIG_PATH, JSON.stringify(serializable, null, 2) + "\n", "utf8");
}

module.exports = {
	loadConfig,
	saveConfig,
	ROOT_DIR,
	DATA_DIR,
	CONFIG_PATH,
	DB_PATH
};
