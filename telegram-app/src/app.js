const crypto = require("crypto");
const express = require("express");
const path = require("path");
const iconv = require("iconv-lite");
const { Telegraf, Markup } = require("telegraf");
const { loadConfig, saveConfig } = require("./config");
const { createDatabase } = require("./db");
const { buildAnarchySnapshot, buildAnarchySnapshotFromPushRows, filterAndSortEvents } = require("./event-source");
const { attachRemoteSqliteBackup } = require("./sqlite-remote-backup");

const config = loadConfig();
const db = createDatabase(config.dbPath);
attachRemoteSqliteBackup(db, {
	dbPath: config.dbPath,
	connectionString: config.databaseBackupUrl,
	backupKey: config.databaseBackupKey,
	logger: console
});
const webApp = express();
const adminSessions = new Map();
const siteSessions = new Map();

function createDisabledBot() {
	const resolved = Promise.resolve();
	return {
		telegram: {
			sendMessage: async () => {
				throw new Error("telegram_bot_disabled");
			},
			getChatMember: async () => {
				throw new Error("telegram_bot_disabled");
			}
		},
		use: () => {},
		command: () => {},
		start: () => {},
		action: () => {},
		on: () => {},
		catch: () => {},
		launch: () => resolved,
		stop: () => {}
	};
}

const bot = String(config.botToken || "").trim()
	? new Telegraf(config.botToken)
	: createDisabledBot();

const DEFAULT_USER_SETTINGS = {
	activeOnly: false,
	sortMode: "time_asc",
	sortDirection: "asc",
	eventFilters: []
};

const REMINDER_INTERVALS = {
	none: 0,
	minute: 60 * 1000,
	hour: 60 * 60 * 1000,
	day: 24 * 60 * 60 * 1000
};

const REMINDER_INTERVAL_LABELS = {
	none: "без повторных напоминаний",
	minute: "раз в 1 минуту до подписки",
	hour: "раз в 1 час до подписки",
	day: "раз в 1 день до подписки"
};

const TELEGRAM_EVENTS_PAGE_SIZE = 8;

const getReminderRowStmt = db.prepare(`
	SELECT last_sent_at
	FROM subscription_reminders
	WHERE user_id = ? AND subscription_id = ?
`);

const upsertReminderStmt = db.prepare(`
	INSERT OR REPLACE INTO subscription_reminders (user_id, subscription_id, last_sent_at)
	VALUES (?, ?, ?)
`);

const deleteReminderStmt = db.prepare(`
	DELETE FROM subscription_reminders
	WHERE user_id = ? AND subscription_id = ?
`);

const deleteReminderBySubscriptionStmt = db.prepare(`
	DELETE FROM subscription_reminders
	WHERE subscription_id = ?
`);

const listEventSnapshotRowsStmt = db.prepare(`
	SELECT anarchy, summary_text, raw_lines_json, updated_at, source
	FROM event_snapshots
	ORDER BY anarchy ASC
`);

const upsertEventSnapshotStmt = db.prepare(`
	INSERT INTO event_snapshots (anarchy, summary_text, raw_lines_json, updated_at, source)
	VALUES (?, ?, ?, ?, ?)
	ON CONFLICT(anarchy) DO UPDATE SET
		summary_text = excluded.summary_text,
		raw_lines_json = excluded.raw_lines_json,
		updated_at = excluded.updated_at,
		source = excluded.source
`);

function nowIso() {
	return new Date().toISOString();
}

function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const MOJIBAKE_PATTERN = /(?:Р.|С.|в.|п.){2,}/u;

function maybeFixMojibake(value) {
	if (typeof value !== "string" || !MOJIBAKE_PATTERN.test(value)) {
		return value;
	}

	try {
		const decoded = iconv.decode(iconv.encode(value, "win1251"), "utf8");
		return decoded.includes("\uFFFD") ? value : decoded;
	} catch {
		return value;
	}
}

function normalizeOutgoingDeep(value) {
	if (typeof value === "string") {
		return maybeFixMojibake(value);
	}

	if (Array.isArray(value)) {
		return value.map((item) => normalizeOutgoingDeep(item));
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, normalizeOutgoingDeep(item)])
		);
	}

	return value;
}

function parseJson(rawValue, fallback) {
	try {
		return JSON.parse(rawValue);
	} catch {
		return fallback;
	}
}

function normalizeAnarchy(value) {
	const raw = String(value || "").trim().toLowerCase();
	if (!raw) {
		return "";
	}

	if (/^\/an\d+$/.test(raw)) {
		return raw;
	}

	if (/^an\d+$/.test(raw)) {
		return `/${raw}`;
	}

	const digits = raw.replace(/[^0-9]/g, "");
	return digits ? `/an${digits}` : "";
}

function normalizeRawLines(lines) {
	if (!Array.isArray(lines)) {
		return [];
	}

	return lines
		.map((line) => maybeFixMojibake(String(line || "")).trim())
		.filter(Boolean)
		.slice(0, 24);
}

function getPushSnapshot() {
	return buildAnarchySnapshotFromPushRows(listEventSnapshotRowsStmt.all(), {
		timeZone: config.timeZone
	});
}

function getRequestBearerToken(req) {
	const authorization = String(req.headers.authorization || "").trim();
	const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
	if (bearerMatch) {
		return bearerMatch[1].trim();
	}

	return String(req.headers["x-event-token"] || "").trim();
}

function randomToken(size = 24) {
	return crypto.randomBytes(size).toString("hex");
}

function hashPassword(password) {
	const salt = randomToken(16);
	const derived = crypto.scryptSync(password, salt, 64).toString("hex");
	return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
	const [salt, hash] = String(storedHash || "").split(":");
	if (!salt || !hash) {
		return false;
	}

	const derived = crypto.scryptSync(password, salt, 64).toString("hex");
	return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
}

function getUserSettings(userRow) {
	return normalizeSettings({
		...DEFAULT_USER_SETTINGS,
		...parseJson(userRow?.settings_json || "{}", {})
	});
}

function normalizeSettings(settings) {
	const sortMode = [
		"time_asc",
		"time_desc",
		"anarchy_asc",
		"anarchy_desc"
	].includes(settings.sortMode)
		? settings.sortMode
		: (settings.sortDirection === "desc" ? "time_desc" : "time_asc");

	return {
		activeOnly: Boolean(settings.activeOnly),
		sortMode,
		sortDirection: sortMode.endsWith("_desc") ? "desc" : "asc",
		eventFilters: Array.isArray(settings.eventFilters) ? [...new Set(settings.eventFilters)] : []
	};
}

function setUserSettings(userId, settings) {
	const normalized = normalizeSettings(settings);
	db.prepare("UPDATE users SET settings_json = ?, last_seen_at = ? WHERE id = ?")
		.run(JSON.stringify(normalized), nowIso(), userId);
	return normalized;
}

function getWebUserSettings(webUserRow) {
	return normalizeSettings({
		...DEFAULT_USER_SETTINGS,
		...parseJson(webUserRow?.settings_json || "{}", {})
	});
}

function setWebUserSettings(webUserId, settings) {
	const normalized = normalizeSettings(settings);
	db.prepare("UPDATE web_users SET settings_json = ? WHERE id = ?")
		.run(JSON.stringify(normalized), webUserId);
	return normalized;
}

function getEventCatalog(snapshot) {
	return [...new Set([...(config.knownEvents || []), ...(snapshot.eventNames || [])])]
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right, "ru", { sensitivity: "base" }));
}

function getSnapshotSettings(userRow, snapshot) {
	const settings = getUserSettings(userRow);
	const catalog = new Set(getEventCatalog(snapshot));
	const eventFilters = settings.eventFilters.filter((eventName) => catalog.has(eventName));
	if (eventFilters.length === settings.eventFilters.length) {
		return settings;
	}

	return setUserSettings(userRow.id, {
		...settings,
		eventFilters
	});
}

function getPortalSnapshotSettings(webUserRow, snapshot) {
	const settings = getWebUserSettings(webUserRow);
	const catalog = new Set(getEventCatalog(snapshot));
	const eventFilters = settings.eventFilters.filter((eventName) => catalog.has(eventName));
	if (eventFilters.length === settings.eventFilters.length) {
		return settings;
	}

	return setWebUserSettings(webUserRow.id, {
		...settings,
		eventFilters
	});
}

function parseSubscriptionUsername(url) {
	if (!url) {
		return "";
	}

	try {
		const normalized = url.replace("https://", "").replace("http://", "");
		const match = normalized.match(/(?:t\.me|telegram\.me)\/(@?[\w\d_]+)/i);
		return match ? match[1].replace(/^@/, "") : "";
	} catch {
		return "";
	}
}

function listEnabledSubscriptions() {
	return (config.requiredSubscriptions || []).filter((item) => item.enabled !== false);
}

function getReminderIntervalMs(value) {
	return REMINDER_INTERVALS[String(value || "none")] || 0;
}

function getReminderIntervalLabel(value) {
	return REMINDER_INTERVAL_LABELS[String(value || "none")] || REMINDER_INTERVAL_LABELS.none;
}

function getReminderIntervalOptions() {
	return [
		{ value: "none", label: "РўРѕР»СЊРєРѕ РѕРґРёРЅ СЂР°Р· РїСЂРё РґРѕР±Р°РІР»РµРЅРёРё" },
		{ value: "minute", label: "РџРѕРєР° РЅРµ РїРѕРґРїРёС€РµС‚СЃСЏ: СЂР°Р· РІ 1 РјРёРЅСѓС‚Сѓ" },
		{ value: "hour", label: "РџРѕРєР° РЅРµ РїРѕРґРїРёС€РµС‚СЃСЏ: СЂР°Р· РІ 1 С‡Р°СЃ" },
		{ value: "day", label: "РџРѕРєР° РЅРµ РїРѕРґРїРёС€РµС‚СЃСЏ: СЂР°Р· РІ 1 РґРµРЅСЊ" }
	];
}

function buildSubscriptionPrompt(missingSubscriptions, options = {}) {
	const reminder = Boolean(options.reminder);
	const title = reminder
		? "<b>РќР°РїРѕРјРёРЅР°РЅРёРµ Рѕ РїРѕРґРїРёСЃРєРµ</b>"
		: "<b>Р”Р»СЏ СЂР°Р±РѕС‚С‹ Р±РѕС‚Р° РїРѕРґРїРёС€РёСЃСЊ РЅР° РєР°РЅР°Р»С‹ РЅРёР¶Рµ</b>";

	const lines = [
		title,
		"",
		"РџРѕРєР° С‚С‹ РЅРµ РїРѕРґРїРёС€РµС€СЊСЃСЏ РЅР° РІСЃРµ РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Рµ РєР°РЅР°Р»С‹, Р±РѕС‚ СЂР°Р±РѕС‚Р°С‚СЊ РЅРµ Р±СѓРґРµС‚.",
		"",
		...missingSubscriptions.map((item, index) => `${index + 1}. ${escapeHtml(item.title || item.url)}`)
	];

	const rows = missingSubscriptions.map((item) => [Markup.button.url(item.title || item.url, item.url)]);
	rows.push([Markup.button.callback("РџСЂРѕРІРµСЂРёС‚СЊ РїРѕРґРїРёСЃРєСѓ", "subs:check")]);
	rows.push([Markup.button.callback("РќР°Р·Р°Рґ РІ РјРµРЅСЋ", "subs:menu")]);

	return {
		text: lines.join("\n"),
		keyboard: Markup.inlineKeyboard(rows)
	};
}

function buildSubscriptionVerificationErrorPrompt(problemSubscriptions) {
	const lines = [
		"<b>РџСЂРѕРІРµСЂРєР° РїРѕРґРїРёСЃРєРё СЃРµР№С‡Р°СЃ РЅРµРґРѕСЃС‚СѓРїРЅР°</b>",
		"",
		"Р‘РѕС‚ РЅРµ РјРѕР¶РµС‚ РїСЂРѕРІРµСЂРёС‚СЊ, РїРѕРґРїРёСЃР°РЅ Р»Рё С‚С‹ РЅР° СЌС‚Рё РєР°РЅР°Р»С‹:",
		"",
		...problemSubscriptions.map((item, index) => `${index + 1}. ${escapeHtml(item.title || item.url)}`),
		"",
		"Р§С‚Рѕ РЅСѓР¶РЅРѕ СЃРґРµР»Р°С‚СЊ РІР»Р°РґРµР»СЊС†Сѓ Р±РѕС‚Р°:",
		"1. Р”РѕР±Р°РІРёС‚СЊ Р±РѕС‚Р° РІ РЅСѓР¶РЅС‹Р№ РєР°РЅР°Р».",
		"2. Р’С‹РґР°С‚СЊ Р±РѕС‚Сѓ РїСЂР°РІР° Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂР°.",
		"3. РџРѕСЃР»Рµ СЌС‚РѕРіРѕ СЃРЅРѕРІР° РЅР°Р¶Р°С‚СЊ /start РёР»Рё В«РџСЂРѕРІРµСЂРёС‚СЊ РїРѕРґРїРёСЃРєСѓВ»."
	];

	return {
		text: lines.join("\n"),
		keyboard: Markup.inlineKeyboard([
			[Markup.button.callback("РќР°Р·Р°Рґ РІ РјРµРЅСЋ", "subs:menu")]
		])
	};
}

function isSubscriptionCheckInaccessible(error) {
	const message = String(error?.message || "").toLowerCase();
	return message.includes("member list is inaccessible")
		|| message.includes("chat not found")
		|| message.includes("bot is not a member")
		|| message.includes("have no rights")
		|| message.includes("administrator rights");
}

function markReminderSent(userId, subscriptionId) {
	upsertReminderStmt.run(userId, subscriptionId, nowIso());
}

function clearReminderState(userId, subscriptionId) {
	deleteReminderStmt.run(userId, subscriptionId);
}

function isReminderDue(userId, subscription) {
	const intervalMs = getReminderIntervalMs(subscription.reminderInterval);
	if (!intervalMs) {
		return false;
	}

	const row = getReminderRowStmt.get(userId, subscription.id);
	if (!row?.last_sent_at) {
		return true;
	}

	return Date.now() - Date.parse(row.last_sent_at) >= intervalMs;
}

async function inspectSubscriptionsForUser(user, subscriptions = listEnabledSubscriptions()) {
	const missing = [];
	const unverifiable = [];

	for (const item of subscriptions) {
		if (!item.username) {
			unverifiable.push({
				...item,
				reason: "missing_username"
			});
			continue;
		}

		try {
			const member = await bot.telegram.getChatMember(`@${item.username}`, Number(user.telegram_id));
			if (["creator", "administrator", "member", "restricted"].includes(member.status)) {
				clearReminderState(user.id, item.id);
				continue;
			}
		} catch (error) {
			if (isSubscriptionCheckInaccessible(error)) {
				unverifiable.push({
					...item,
					reason: "member_list_inaccessible"
				});
				continue;
			}
		}

		missing.push(item);
	}

	return {
		missing,
		unverifiable
	};
}

async function buildSubscriptionStateForUser(user, subscriptions = listEnabledSubscriptions()) {
	if (!user) {
		return {
			hasRequirements: subscriptions.length > 0,
			missing: subscriptions,
			missingCount: subscriptions.length,
			unverifiable: false,
			unverifiableItems: [],
			subscribed: false
		};
	}

	if (!subscriptions.length) {
		return {
			hasRequirements: false,
			missing: [],
			missingCount: 0,
			unverifiable: false,
			unverifiableItems: [],
			subscribed: true
		};
	}

	const { missing, unverifiable } = await inspectSubscriptionsForUser(user, subscriptions);
	return {
		hasRequirements: true,
		missing,
		missingCount: missing.length,
		unverifiable: unverifiable.length > 0,
		unverifiableItems: unverifiable,
		subscribed: !missing.length && !unverifiable.length
	};
}

function getStatusMeta(user, subscriptionState) {
	if (user?.is_blocked && user?.block_reason === "manual") {
		return {
			label: "Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ Р°РґРјРёРЅРѕРј",
			badgeClass: "badge-danger"
		};
	}

	if (subscriptionState?.unverifiable) {
		return {
			label: "СЃС‚Р°С‚СѓСЃ РїРѕРґРїРёСЃРєРё РЅРµ СѓРґР°Р»РѕСЃСЊ РїСЂРѕРІРµСЂРёС‚СЊ",
			badgeClass: "badge-muted"
		};
	}

	if (subscriptionState?.hasRequirements && subscriptionState.missingCount > 0) {
		return {
			label: "РЅРµ РїРѕРґРїРёСЃР°РЅ, Р±РѕС‚ Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ",
			badgeClass: "badge-danger"
		};
	}

	return {
		label: "РїРѕРґРїРёСЃР°РЅ, СЃ Р±РѕС‚РѕРј РІСЃРµ РЅРѕСЂРјР°Р»СЊРЅРѕ",
		badgeClass: "badge-ok"
	};
}

async function annotateUsersWithSubscriptionState(users, subscriptions = listEnabledSubscriptions()) {
	return Promise.all(users.map(async (user) => {
		const subscriptionState = await buildSubscriptionStateForUser(user, subscriptions);
		return {
			...user,
			subscriptionState,
			statusMeta: getStatusMeta(user, subscriptionState)
		};
	}));
}

function upsertUser(from) {
	const existing = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(String(from.id));
	if (existing) {
		db.prepare(`
			UPDATE users
			SET username = ?, first_name = ?, last_name = ?, last_seen_at = ?
			WHERE id = ?
		`).run(from.username || "", from.first_name || "", from.last_name || "", nowIso(), existing.id);
		return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
	}

	const result = db.prepare(`
		INSERT INTO users (telegram_id, username, first_name, last_name, settings_json, created_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(
		String(from.id),
		from.username || "",
		from.first_name || "",
		from.last_name || "",
		JSON.stringify(DEFAULT_USER_SETTINGS),
		nowIso(),
		nowIso()
	);

	return db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
}

function logMessage(userId, direction, messageType, text, payload = null) {
	db.prepare(`
		INSERT INTO user_messages (user_id, direction, message_type, text, payload_json, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(userId, direction, messageType, text || "", payload ? JSON.stringify(payload) : null, nowIso());
}

function logAdminEvent(eventType, payload) {
	db.prepare(`
		INSERT INTO admin_events (event_type, payload_json, created_at)
		VALUES (?, ?, ?)
	`).run(eventType, JSON.stringify(payload || {}), nowIso());
}

function getEventModeMeta(mode) {
	if (mode === "current") {
		return {
			emoji: "🔥",
			title: "Текущие ивенты",
			description: "Активные события и их актуальные стадии.",
			emptyText: "Сейчас по выбранным условиям активных ивентов нет."
		};
	}

	if (mode === "upcoming") {
		return {
			emoji: "⏳",
			title: "Предстоящие ивенты",
			description: "Ближайшие события и таймеры до их начала.",
			emptyText: "По выбранным условиям ближайших ивентов пока нет."
		};
	}

	return {
		emoji: "🗂️",
		title: "Все ивенты",
		description: "Полный список событий по текущим фильтрам.",
		emptyText: "По выбранным условиям ивентов пока нет."
	};
}

function getSortModeLabel(settings) {
	switch (settings.sortMode) {
		case "time_desc":
			return "по времени: сначала дальние";
		case "anarchy_asc":
			return "по анархиям: от меньшей к большей";
		case "anarchy_desc":
			return "по анархиям: от большей к меньшей";
		default:
			return "по времени: сначала ближайшие";
	}
}

function getEventTypeEmoji(event) {
	if (event.type === "active") {
		return "🔥";
	}

	if (event.type === "scheduled") {
		return "🟣";
	}

	if (event.type === "next") {
		return "⏳";
	}

	return "📌";
}

function getEventListPage(events, requestedPage = 0) {
	const totalPages = Math.max(1, Math.ceil(events.length / TELEGRAM_EVENTS_PAGE_SIZE));
	const page = Math.min(Math.max(Number(requestedPage) || 0, 0), totalPages - 1);
	const start = page * TELEGRAM_EVENTS_PAGE_SIZE;
	return {
		page,
		totalPages,
		items: events.slice(start, start + TELEGRAM_EVENTS_PAGE_SIZE)
	};
}

function formatEventLine(event) {
	const parts = [
		`${getEventTypeEmoji(event)} ${event.label}`,
		`анархия ${event.anarchy}`
	];

	if (event.stage) {
		parts.push(`стадия ${event.stage}`);
	} else if (event.statusText) {
		parts.push(event.statusText);
	}

	if (event.timerText) {
		parts.push(`таймер ${event.timerText}`);
	}

	if (event.coordinates) {
		parts.push(`коорд. ${event.coordinates}`);
	}

	return parts.join(" • ");
}

function formatEventList(mode, events, settings, snapshot, requestedPage = 0) {
	const meta = getEventModeMeta(mode);
	const pageData = getEventListPage(events, requestedPage);
	const lines = [
		`<b>${meta.emoji} ${escapeHtml(meta.title)}</b>`,
		escapeHtml(meta.description),
		`Обновлено: ${escapeHtml(snapshot.lastUpdatedAt || "нет данных")}`,
		`Сортировка: ${escapeHtml(getSortModeLabel(settings))}`,
		`Показывать: ${settings.activeOnly ? "только активные и известные" : "все найденные"}`
	];

	if (settings.eventFilters.length) {
		lines.push(`Ивенты: ${escapeHtml(settings.eventFilters.join(", "))}`);
	}

	if (!events.length) {
		lines.push("");
		lines.push(escapeHtml(meta.emptyText));
		return {
			text: lines.join("\n"),
			page: 0,
			totalPages: 1
		};
	}

	lines.push(`Страница: ${pageData.page + 1}/${pageData.totalPages} • Всего: ${events.length}`);
	lines.push("");

	pageData.items.forEach((event, index) => {
		const number = pageData.page * TELEGRAM_EVENTS_PAGE_SIZE + index + 1;
		lines.push(`${number}. ${escapeHtml(formatEventLine(event))}`);
	});

	return {
		text: lines.join("\n"),
		page: pageData.page,
		totalPages: pageData.totalPages
	};
}

function buildMainMenuRows(activeMode = null) {
	const currentLabel = `${activeMode === "current" ? "• " : ""}🔥 Сейчас`;
	const upcomingLabel = `${activeMode === "upcoming" ? "• " : ""}⏳ Скоро`;
	const allLabel = `${activeMode === "all" ? "• " : ""}🗂️ Все`;

	return [
		[
			Markup.button.callback(currentLabel, "menu:current"),
			Markup.button.callback(upcomingLabel, "menu:upcoming")
		],
		[
			Markup.button.callback(allLabel, "menu:all"),
			Markup.button.callback("⚙️ Настройки", "menu:settings")
		]
	];
}

function mainMenuKeyboard(activeMode = null) {
	return Markup.inlineKeyboard(buildMainMenuRows(activeMode));
}

function eventListKeyboard(mode, page, totalPages) {
	const rows = [];

	if (totalPages > 1) {
		rows.push([
			Markup.button.callback(page > 0 ? "⬅️" : "•", page > 0 ? `events:view:${mode}:${page - 1}` : "events:noop"),
			Markup.button.callback(`📄 ${page + 1}/${totalPages}`, "events:noop"),
			Markup.button.callback(page < totalPages - 1 ? "➡️" : "•", page < totalPages - 1 ? `events:view:${mode}:${page + 1}` : "events:noop")
		]);
	}

	rows.push(...buildMainMenuRows(mode));
	rows.push([Markup.button.callback("🏠 В меню", "events:menu")]);

	return Markup.inlineKeyboard(rows);
}

function settingsKeyboard(settings) {
	return Markup.inlineKeyboard([
		[
			Markup.button.callback(
				`${settings.activeOnly ? "✅" : "⬜"} Только активные и известные`,
				"settings:toggle_active"
			)
		],
		[
			Markup.button.callback(
				`${settings.sortMode === "time_asc" ? "✅" : "⬜"} ⏱️ Ближе`,
				"settings:sort_time_asc"
			),
			Markup.button.callback(
				`${settings.sortMode === "time_desc" ? "✅" : "⬜"} 🕰️ Дальше`,
				"settings:sort_time_desc"
			)
		],
		[
			Markup.button.callback(
				`${settings.sortMode === "anarchy_asc" ? "✅" : "⬜"} 🧭 Анархии ↑`,
				"settings:sort_anarchy_asc"
			),
			Markup.button.callback(
				`${settings.sortMode === "anarchy_desc" ? "✅" : "⬜"} 🧭 Анархии ↓`,
				"settings:sort_anarchy_desc"
			)
		],
		[
			Markup.button.callback("🧩 Фильтр событий", "settings:filters")
		],
		[
			Markup.button.callback("🏠 В меню", "settings:back_menu")
		]
	]);
}

function filtersKeyboard(settings, snapshot) {
	const catalog = getEventCatalog(snapshot);
	const rows = catalog.map((eventName, index) => [
		Markup.button.callback(
			`${settings.eventFilters.includes(eventName) ? "✅" : "▫️"} ${eventName}`,
			`filter:${index}`
		)
	]);

	rows.push([
		Markup.button.callback("🧹 Очистить", "filter:clear"),
		Markup.button.callback("✅ Готово", "filter:save")
	]);
	rows.push([
		Markup.button.callback("⬅️ К настройкам", "filter:back")
	]);

	return Markup.inlineKeyboard(rows);
}

function settingsText(settings) {
	return [
		"<b>⚙️ Настройки</b>",
		"",
		`Показывать: ${settings.activeOnly ? "только активные и известные" : "все найденные"}`,
		`Сортировка: ${getSortModeLabel(settings)}`,
		`Фильтр событий: ${settings.eventFilters.length ? settings.eventFilters.join(", ") : "все события"}`
	].join("\n");
}

function filterText(settings) {
	return [
		"<b>🧩 Фильтр событий</b>",
		"",
		"Отметь события, которые нужно оставить в списках.",
		`Сейчас выбрано: ${settings.eventFilters.length ? settings.eventFilters.join(", ") : "все события"}`
	].join("\n");
}

function buildMainMenuText(firstName) {
	return [
		`<b>Привет, ${escapeHtml(firstName || "игрок")} 👋</b>`,
		"",
		"Здесь можно быстро смотреть текущие, ближайшие и все найденные ивенты.",
		"Выбери раздел кнопками ниже.",
		"",
		"Для привязки сайта к Telegram используй команду <code>/link КОД</code>."
	].join("\n");
}

async function renderEventListView(ctx, user, mode, requestedPage = 0) {
	const snapshot = getSnapshot();
	const settings = getSnapshotSettings(user, snapshot);
	const events = filterAndSortEvents(snapshot, settings, mode);
	const view = formatEventList(mode, events, settings, snapshot, requestedPage);
	await editOrReply(ctx, view.text, eventListKeyboard(mode, view.page, view.totalPages));
}

async function sendMenu(ctx, text = buildMainMenuText(ctx.from?.first_name)) {
	return ctx.reply(normalizeOutgoingDeep(text), normalizeOutgoingDeep({
		parse_mode: "HTML",
		...mainMenuKeyboard()
	}));
}

function isIgnorableTelegramError(error) {
	const message = String(error?.message || "").toLowerCase();
	return message.includes("query is too old")
		|| message.includes("query id is invalid")
		|| message.includes("message is not modified")
		|| message.includes("message to edit not found");
}

async function safeAnswerCallback(ctx, text) {
	if (!ctx.callbackQuery) {
		return;
	}

	try {
		await ctx.answerCbQuery(maybeFixMojibake(text));
	} catch (error) {
		if (!isIgnorableTelegramError(error)) {
			throw error;
		}
	}
}

async function editOrReply(ctx, text, extra) {
	try {
		if (ctx.callbackQuery?.message) {
			return await ctx.editMessageText(
				normalizeOutgoingDeep(text),
				normalizeOutgoingDeep({ parse_mode: "HTML", ...extra })
			);
		}
	} catch (error) {
		if (!isIgnorableTelegramError(error)) {
			throw error;
		}
	}

	return ctx.reply(
		normalizeOutgoingDeep(text),
		normalizeOutgoingDeep({ parse_mode: "HTML", ...extra })
	);
}

async function sendTelegramHtml(chatId, text, extra = {}) {
	return bot.telegram.sendMessage(
		chatId,
		normalizeOutgoingDeep(text),
		normalizeOutgoingDeep({ parse_mode: "HTML", ...extra })
	);
}

async function checkRequiredSubscriptions(ctx, user) {
	const subscriptions = listEnabledSubscriptions();
	if (!subscriptions.length) {
		return true;
	}

	const { missing, unverifiable } = await inspectSubscriptionsForUser(user, subscriptions);
	if (unverifiable.length) {
		const prompt = buildSubscriptionVerificationErrorPrompt(unverifiable);
		await editOrReply(ctx, prompt.text, prompt.keyboard);
		return false;
	}

	if (!missing.length) {
		return true;
	}

	const prompt = buildSubscriptionPrompt(missing);
	await editOrReply(ctx, prompt.text, prompt.keyboard);
	return false;
}

function getSnapshot() {
	const pushedSnapshot = getPushSnapshot();
	if (config.snapshotSourceMode === "push") {
		return pushedSnapshot;
	}

	if (config.snapshotSourceMode === "auto" && pushedSnapshot.rawCount > 0) {
		return pushedSnapshot;
	}

	return buildAnarchySnapshot(config.checkerLogPath);
}

async function announceMandatorySubscriptionsChange() {
	const users = db.prepare("SELECT * FROM users WHERE is_blocked = 0").all();
	const subscriptions = listEnabledSubscriptions();
	if (!subscriptions.length) {
		return;
	}

	for (const user of users) {
		const { missing, unverifiable } = await inspectSubscriptionsForUser(user, subscriptions);
		if (unverifiable.length) {
			logAdminEvent("subscription_verification_unavailable", {
				userId: user.id,
				subscriptionIds: unverifiable.map((item) => item.id)
			});
			continue;
		}

		if (!missing.length) {
			continue;
		}

		const prompt = buildSubscriptionPrompt(missing);
		try {
			await sendTelegramHtml(user.telegram_id, prompt.text, prompt.keyboard);
			logMessage(user.id, "out", "subscription_announcement", prompt.text, {
				subscriptionIds: missing.map((item) => item.id)
			});
			for (const item of missing) {
				markReminderSent(user.id, item.id);
			}
		} catch {
			db.prepare("UPDATE users SET is_blocked = 1, block_reason = 'delivery_failed' WHERE id = ?").run(user.id);
		}
	}
}

async function processSubscriptionReminders() {
	const subscriptions = listEnabledSubscriptions().filter((item) => getReminderIntervalMs(item.reminderInterval) > 0);
	if (!subscriptions.length) {
		return;
	}

	const users = db.prepare("SELECT * FROM users WHERE is_blocked = 0").all();
	for (const user of users) {
		const { missing, unverifiable } = await inspectSubscriptionsForUser(user, subscriptions);
		if (unverifiable.length || !missing.length) {
			continue;
		}

		const dueSubscriptions = missing.filter((item) => isReminderDue(user.id, item));
		if (!dueSubscriptions.length) {
			continue;
		}

		const prompt = buildSubscriptionPrompt(missing, { reminder: true });
		try {
			await sendTelegramHtml(user.telegram_id, prompt.text, prompt.keyboard);
			logMessage(user.id, "out", "subscription_reminder", prompt.text, {
				subscriptionIds: dueSubscriptions.map((item) => item.id)
			});
			dueSubscriptions.forEach((item) => markReminderSent(user.id, item.id));
		} catch {
			db.prepare("UPDATE users SET is_blocked = 1, block_reason = 'delivery_failed' WHERE id = ?").run(user.id);
		}
	}
}

function getCookie(req, name) {
	const cookie = req.headers.cookie || "";
	const match = cookie.match(new RegExp(`${name}=([^;]+)`));
	return match ? match[1] : "";
}

function setCookie(res, name, value) {
	res.setHeader("Set-Cookie", `${name}=${value}; HttpOnly; Path=/; SameSite=Lax`);
}

function clearCookie(res, name) {
	res.setHeader("Set-Cookie", `${name}=; Max-Age=0; Path=/; SameSite=Lax`);
}

function getSiteSession(req) {
	return siteSessions.get(getCookie(req, "site_session"));
}

function getSiteUserBySession(session) {
	if (!session) {
		return null;
	}

	return db.prepare("SELECT * FROM web_users WHERE id = ?").get(session.webUserId) || null;
}

function requireAdmin(req, res, next) {
	const session = adminSessions.get(getCookie(req, "panel_session"));
	if (!session) {
		return res.redirect("/login");
	}

	res.locals.session = session;
	return next();
}

function requireSiteUser(req, res, next) {
	const session = getSiteSession(req);
	if (!session) {
		return res.redirect("/site/login");
	}

	const webUser = getSiteUserBySession(session);
	if (!webUser) {
		siteSessions.delete(getCookie(req, "site_session"));
		clearCookie(res, "site_session");
		return res.redirect("/site/login");
	}

	req.siteSession = session;
	req.webUser = webUser;
	return next();
}

function renderAdmin(res, view, data = {}) {
	res.render(view, {
		pageTitle: "Event Bot Admin",
		escapeHtml,
		...normalizeOutgoingDeep(data)
	});
}

function renderPortal(res, view, data = {}) {
	res.render(view, {
		pageTitle: "Event Bot Portal",
		escapeHtml,
		...normalizeOutgoingDeep(data)
	});
}

function createLinkCode() {
	return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function getStartPayload(ctx) {
	const text = String(ctx.message?.text || "");
	const parts = text.split(/\s+/);
	return parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
}

function getBotLinkUrl(code) {
	const botUsername = String(config.botUsername || "").trim().replace(/^@+/, "");
	if (!botUsername || !code) {
		return "";
	}

	return `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(`link_${code}`)}`;
}

function getLinkInstructions(code) {
	const botLinkUrl = getBotLinkUrl(code);
	const steps = [
		botLinkUrl
			? `1. <a href="${escapeHtml(botLinkUrl)}" target="_blank" rel="noreferrer">Открыть Telegram-бота для привязки</a>.`
			: "1. Открой Telegram-бота.",
		`2. Отправь ему команду <code>/link ${escapeHtml(code)}</code>.`,
		"3. После подтверждения вернись на сайт и обнови страницу."
	];

	if (botLinkUrl) {
		steps.splice(1, 0, `Или сразу открой deep-link: <a href="${escapeHtml(botLinkUrl)}" target="_blank" rel="noreferrer">${escapeHtml(botLinkUrl)}</a>.`);
	}

	return steps.join("<br />");
}

function buildPortalAccessState(webUser, linkedTelegramUser, subscriptionState) {
	if (!linkedTelegramUser) {
		return {
			allowed: false,
			tone: "warn",
			title: "РќСѓР¶РЅРѕ РїСЂРёРІСЏР·Р°С‚СЊ Telegram",
			description: "Р‘РµР· РїСЂРёРІСЏР·РєРё Telegram РјС‹ РЅРµ СЃРјРѕР¶РµРј РїСЂРѕРІРµСЂРёС‚СЊ РїРѕРґРїРёСЃРєСѓ РЅР° РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Рµ РєР°РЅР°Р»С‹."
		};
	}

	if (linkedTelegramUser.is_blocked && linkedTelegramUser.block_reason === "manual") {
		return {
			allowed: false,
			tone: "danger",
			title: "Р”РѕСЃС‚СѓРї РѕСЃС‚Р°РЅРѕРІР»РµРЅ",
			description: "Р­С‚РѕС‚ Telegram-Р°РєРєР°СѓРЅС‚ Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂРѕРј."
		};
	}

	if (subscriptionState.unverifiable) {
		return {
			allowed: false,
			tone: "warn",
			title: "РџРѕРґРїРёСЃРєСѓ РїРѕРєР° РЅРµР»СЊР·СЏ РїСЂРѕРІРµСЂРёС‚СЊ",
			description: "Р‘РѕС‚ РµС‰С‘ РЅРµ РјРѕР¶РµС‚ РїСЂРѕРІРµСЂРёС‚СЊ С‡Р°СЃС‚СЊ РєР°РЅР°Р»РѕРІ. РћР±С‹С‡РЅРѕ СЌС‚Рѕ Р»РµС‡РёС‚СЃСЏ РІС‹РґР°С‡РµР№ РїСЂР°РІ Р±РѕС‚Сѓ РІ РєР°РЅР°Р»Рµ."
		};
	}

	if (subscriptionState.hasRequirements && subscriptionState.missingCount > 0) {
		return {
			allowed: false,
			tone: "danger",
			title: "РќРµС‚ РґРѕСЃС‚СѓРїР° Рє РёРІРµРЅС‚Р°Рј",
			description: "РЎРЅР°С‡Р°Р»Р° РїРѕРґРїРёС€РёСЃСЊ РЅР° РІСЃРµ РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Рµ Telegram-РєР°РЅР°Р»С‹ РёР· СЃРїРёСЃРєР° РЅРёР¶Рµ."
		};
	}

	return {
		allowed: true,
		tone: "ok",
		title: "Р”РѕСЃС‚СѓРї РѕС‚РєСЂС‹С‚",
		description: "РџРѕРґРїРёСЃРєР° РїРѕРґС‚РІРµСЂР¶РґРµРЅР°, РёРІРµРЅС‚С‹ Рё РЅР°СЃС‚СЂРѕР№РєРё РґРѕСЃС‚СѓРїРЅС‹."
	};
}

async function buildPortalContext(webUser) {
	const linkedTelegramUser = webUser.linked_telegram_user_id
		? db.prepare("SELECT * FROM users WHERE id = ?").get(webUser.linked_telegram_user_id)
		: null;
	const subscriptionState = await buildSubscriptionStateForUser(linkedTelegramUser);
	const accessState = buildPortalAccessState(webUser, linkedTelegramUser, subscriptionState);
	return {
		webUser,
		linkedTelegramUser,
		subscriptionState,
		accessState
	};
}

async function buildPortalPageState(webUser, snapshot = getSnapshot()) {
	return {
		snapshot,
		settings: getPortalSnapshotSettings(webUser, snapshot),
		subscriptions: listEnabledSubscriptions(),
		linkInstructions: webUser.link_code ? getLinkInstructions(webUser.link_code) : "",
		...await buildPortalContext(webUser)
	};
}

function formatEventCards(events) {
	return events;
}

async function handleLinkCode(ctx, code) {
	const cleanCode = String(code || "").trim().toUpperCase();
	if (!cleanCode) {
		await ctx.reply("РџСЂРёС€Р»Рё РєРѕРґ С‚Р°Рє: /link ABCD1234");
		return;
	}

	const webUser = db.prepare(`
		SELECT *
		FROM web_users
		WHERE upper(link_code) = ?
	`).get(cleanCode);

	if (!webUser || !webUser.link_code_expires_at || Date.parse(webUser.link_code_expires_at) < Date.now()) {
		await ctx.reply("РљРѕРґ РЅРµ РЅР°Р№РґРµРЅ РёР»Рё СѓР¶Рµ РёСЃС‚РµРє. РЎРіРµРЅРµСЂРёСЂСѓР№ РЅРѕРІС‹Р№ РєРѕРґ РЅР° СЃР°Р№С‚Рµ.");
		return;
	}

	const telegramUser = ctx.state.user;
	db.prepare("UPDATE web_users SET linked_telegram_user_id = NULL WHERE linked_telegram_user_id = ?").run(telegramUser.id);
	db.prepare(`
		UPDATE web_users
		SET linked_telegram_user_id = ?, link_code = NULL, link_code_expires_at = NULL
		WHERE id = ?
	`).run(telegramUser.id, webUser.id);

	logAdminEvent("portal_telegram_linked", {
		webUserId: webUser.id,
		telegramUserId: telegramUser.id
	});

	await ctx.reply("Telegram СѓСЃРїРµС€РЅРѕ РїСЂРёРІСЏР·Р°РЅ Рє СЃР°Р№С‚Сѓ. Р’РµСЂРЅРёСЃСЊ РЅР° СЃР°Р№С‚ Рё РѕР±РЅРѕРІРё СЃС‚СЂР°РЅРёС†Сѓ.");
}

bot.use(async (ctx, next) => {
	if (!ctx.from) {
		return next();
	}

	if (typeof ctx.reply === "function") {
		const originalReply = ctx.reply.bind(ctx);
		ctx.reply = (text, extra, ...rest) => originalReply(
			normalizeOutgoingDeep(text),
			normalizeOutgoingDeep(extra),
			...rest
		);
	}

	if (typeof ctx.editMessageText === "function") {
		const originalEditMessageText = ctx.editMessageText.bind(ctx);
		ctx.editMessageText = (text, extra, ...rest) => originalEditMessageText(
			normalizeOutgoingDeep(text),
			normalizeOutgoingDeep(extra),
			...rest
		);
	}

	if (typeof ctx.answerCbQuery === "function") {
		const originalAnswerCbQuery = ctx.answerCbQuery.bind(ctx);
		ctx.answerCbQuery = (text, extra, ...rest) => originalAnswerCbQuery(
			maybeFixMojibake(text),
			normalizeOutgoingDeep(extra),
			...rest
		);
	}

	const user = upsertUser(ctx.from);
	ctx.state.user = user;

	if (ctx.message?.text) {
		logMessage(user.id, "in", "text", ctx.message.text, { updateType: ctx.updateType });
	} else if (ctx.callbackQuery?.data) {
		logMessage(user.id, "in", "callback", ctx.callbackQuery.data, { updateType: ctx.updateType });
	}

	if (user.is_blocked && user.block_reason === "manual") {
		if (ctx.callbackQuery) {
			await safeAnswerCallback(ctx, "Р‘РѕС‚ Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂРѕРј.");
		} else {
			await ctx.reply("Р‘РѕС‚ Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂРѕРј.");
			logMessage(user.id, "out", "blocked_notice", "Р‘РѕС‚ Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂРѕРј.");
		}
		return;
	}

	return next();
});

bot.command("link", async (ctx) => {
	const raw = String(ctx.message?.text || "");
	const code = raw.replace(/^\/link(?:@\w+)?/i, "").trim();
	await handleLinkCode(ctx, code);
});

bot.start(async (ctx) => {
	const payload = getStartPayload(ctx);
	if (payload.toLowerCase().startsWith("link_")) {
		await handleLinkCode(ctx, payload.slice(5));
		return;
	}

	const user = ctx.state.user;
	if (!(await checkRequiredSubscriptions(ctx, user))) {
		return;
	}

	await sendMenu(ctx, buildMainMenuText(ctx.from.first_name));
});

bot.action("menu:current", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	if (!(await checkRequiredSubscriptions(ctx, user))) {
		return;
	}

	await renderEventListView(ctx, user, "current");
});

bot.action("menu:upcoming", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	if (!(await checkRequiredSubscriptions(ctx, user))) {
		return;
	}

	await renderEventListView(ctx, user, "upcoming");
});

bot.action("menu:all", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	if (!(await checkRequiredSubscriptions(ctx, user))) {
		return;
	}

	await renderEventListView(ctx, user, "all");
});

bot.action("menu:settings", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	if (!(await checkRequiredSubscriptions(ctx, user))) {
		return;
	}

	const settings = getSnapshotSettings(user, getSnapshot());
	await editOrReply(ctx, settingsText(settings), settingsKeyboard(settings));
});

bot.action("settings:toggle_active", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	const current = getUserSettings(user);
	const settings = setUserSettings(user.id, {
		...current,
		activeOnly: !current.activeOnly
	});
	await editOrReply(ctx, settingsText(settings), settingsKeyboard(settings));
});

bot.action("settings:sort_time_asc", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	const settings = setUserSettings(user.id, {
		...getUserSettings(user),
		sortMode: "time_asc"
	});
	await editOrReply(ctx, settingsText(settings), settingsKeyboard(settings));
});

bot.action("settings:sort_time_desc", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	const settings = setUserSettings(user.id, {
		...getUserSettings(user),
		sortMode: "time_desc"
	});
	await editOrReply(ctx, settingsText(settings), settingsKeyboard(settings));
});

bot.action("settings:sort_anarchy_asc", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	const settings = setUserSettings(user.id, {
		...getUserSettings(user),
		sortMode: "anarchy_asc"
	});
	await editOrReply(ctx, settingsText(settings), settingsKeyboard(settings));
});

bot.action("settings:sort_anarchy_desc", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	const settings = setUserSettings(user.id, {
		...getUserSettings(user),
		sortMode: "anarchy_desc"
	});
	await editOrReply(ctx, settingsText(settings), settingsKeyboard(settings));
});

bot.action("settings:filters", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	const snapshot = getSnapshot();
	const settings = getSnapshotSettings(user, snapshot);
	await editOrReply(ctx, filterText(settings), filtersKeyboard(settings, snapshot));
});

bot.action(/^events:view:(current|upcoming|all):(\d+)$/, async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	if (!(await checkRequiredSubscriptions(ctx, user))) {
		return;
	}

	await renderEventListView(ctx, user, ctx.match[1], Number(ctx.match[2]));
});

bot.action("events:menu", async (ctx) => {
	await safeAnswerCallback(ctx);
	await editOrReply(ctx, buildMainMenuText(ctx.from?.first_name), mainMenuKeyboard());
});

bot.action("events:noop", async (ctx) => {
	await safeAnswerCallback(ctx);
});

bot.action(/^filter:(\d+)$/, async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	const snapshot = getSnapshot();
	const settings = getSnapshotSettings(user, snapshot);
	const catalog = getEventCatalog(snapshot);
	const index = Number(ctx.match[1]);
	const eventName = catalog[index];
	if (!eventName) {
		return;
	}

	const nextFilters = settings.eventFilters.includes(eventName)
		? settings.eventFilters.filter((item) => item !== eventName)
		: [...settings.eventFilters, eventName];

	const updated = setUserSettings(user.id, {
		...settings,
		eventFilters: nextFilters
	});

	await editOrReply(ctx, filterText(updated), filtersKeyboard(updated, snapshot));
});

bot.action("filter:clear", async (ctx) => {
	await safeAnswerCallback(ctx);
	const user = ctx.state.user;
	const updated = setUserSettings(user.id, {
		...getUserSettings(user),
		eventFilters: []
	});
	await editOrReply(ctx, filterText(updated), filtersKeyboard(updated, getSnapshot()));
});

bot.action("filter:save", async (ctx) => {
	await safeAnswerCallback(ctx);
	const settings = getUserSettings(ctx.state.user);
	await editOrReply(ctx, settingsText(settings), settingsKeyboard(settings));
});

bot.action("filter:back", async (ctx) => {
	await safeAnswerCallback(ctx);
	const settings = getUserSettings(ctx.state.user);
	await editOrReply(ctx, settingsText(settings), settingsKeyboard(settings));
});

bot.action("settings:save", async (ctx) => {
	await safeAnswerCallback(ctx);
	const settings = getUserSettings(ctx.state.user);
	await editOrReply(ctx, settingsText(settings), settingsKeyboard(settings));
});

bot.action(["settings:back_menu", "subs:menu"], async (ctx) => {
	await safeAnswerCallback(ctx);
	await editOrReply(
		ctx,
		buildMainMenuText(ctx.from?.first_name),
		mainMenuKeyboard()
	);
});

bot.action("subs:check", async (ctx) => {
	await safeAnswerCallback(ctx);
	const allowed = await checkRequiredSubscriptions(ctx, ctx.state.user);
	if (allowed) {
		await editOrReply(
			ctx,
			[
				"<b>РџРѕРґРїРёСЃР°РЅ, СЃ Р±РѕС‚РѕРј РІСЃРµ РЅРѕСЂРјР°Р»СЊРЅРѕ</b>",
				"",
				"РўРµРїРµСЂСЊ РјРѕР¶РЅРѕ РїРѕР»СЊР·РѕРІР°С‚СЊСЃСЏ Р±РѕС‚РѕРј."
			].join("\n"),
			mainMenuKeyboard()
		);
	}
});

bot.on("message", async (ctx) => {
	if (!ctx.message?.text || ctx.message.text.startsWith("/")) {
		return;
	}

	if (!(await checkRequiredSubscriptions(ctx, ctx.state.user))) {
		return;
	}

	await sendMenu(
		ctx,
		[
			"<b>Р Р°Р±РѕС‚Р°РµРј С‡РµСЂРµР· РјРµРЅСЋ</b>",
			"",
			"РќР°Р¶РјРё РєРЅРѕРїРєСѓ РЅРёР¶Рµ, С‡С‚РѕР±С‹ РїРѕСЃРјРѕС‚СЂРµС‚СЊ С‚РµРєСѓС‰РёРµ РёР»Рё РїСЂРµРґСЃС‚РѕСЏС‰РёРµ РёРІРµРЅС‚С‹, Р»РёР±Рѕ РѕС‚РєСЂС‹С‚СЊ РЅР°СЃС‚СЂРѕР№РєРё."
		].join("\n")
	);
});

webApp.set("view engine", "ejs");
webApp.set("views", path.join(__dirname, "..", "views"));
webApp.use(express.json({ limit: "256kb" }));
webApp.use(express.urlencoded({ extended: true }));
webApp.use(express.static(path.join(__dirname, "..", "public")));

webApp.post("/api/ingest/event-delay", (req, res) => {
	const expectedToken = String(config.eventIngestToken || "").trim();
	if (!expectedToken) {
		return res.status(503).json({ ok: false, error: "event_ingest_disabled" });
	}

	const token = getRequestBearerToken(req);
	if (token !== expectedToken) {
		return res.status(401).json({ ok: false, error: "invalid_token" });
	}

	const anarchy = normalizeAnarchy(req.body?.anarchy);
	if (!anarchy) {
		return res.status(400).json({ ok: false, error: "invalid_anarchy" });
	}

	const summaryText = maybeFixMojibake(String(req.body?.summaryText || req.body?.messageText || "")).trim();
	const rawLines = normalizeRawLines(req.body?.rawLines);
	if (!summaryText && !rawLines.length) {
		return res.status(400).json({ ok: false, error: "missing_event_payload" });
	}

	const updatedAt = String(req.body?.updatedAt || "").trim();
	const parsedUpdatedAt = updatedAt && !Number.isNaN(new Date(updatedAt).getTime())
		? new Date(updatedAt).toISOString()
		: nowIso();

	upsertEventSnapshotStmt.run(
		anarchy,
		summaryText,
		JSON.stringify(rawLines),
		parsedUpdatedAt,
		"bot"
	);

	return res.json({
		ok: true,
		anarchy,
		updatedAt: parsedUpdatedAt
	});
});

webApp.get("/login", (req, res) => {
	renderAdmin(res, "login", { error: "" });
});

webApp.post("/login", (req, res) => {
	const username = String(req.body.username || "").trim();
	const password = String(req.body.password || "");

	if (username !== config.adminUsername || password !== config.adminPassword) {
		return renderAdmin(res, "login", { error: "РќРµРІРµСЂРЅС‹Р№ Р»РѕРіРёРЅ РёР»Рё РїР°СЂРѕР»СЊ." });
	}

	const token = randomToken();
	adminSessions.set(token, { username, createdAt: nowIso() });
	setCookie(res, "panel_session", token);
	return res.redirect("/");
});

webApp.post("/logout", requireAdmin, (req, res) => {
	adminSessions.delete(getCookie(req, "panel_session"));
	clearCookie(res, "panel_session");
	res.redirect("/login");
});

webApp.get("/", async (req, res) => {
	const session = adminSessions.get(getCookie(req, "panel_session"));
	if (!session) {
		return res.redirect("/site");
	}

	const snapshot = getSnapshot();
	const subscriptions = listEnabledSubscriptions();
	const usersCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
	const messagesCount = db.prepare("SELECT COUNT(*) AS count FROM user_messages").get().count;
	const manualBlockedUsersCount = db.prepare(`
		SELECT COUNT(*) AS count
		FROM users
		WHERE is_blocked = 1 AND block_reason = 'manual'
	`).get().count;
	const allUsers = db.prepare("SELECT * FROM users ORDER BY last_seen_at DESC").all();
	const latestUsers = await annotateUsersWithSubscriptionState(allUsers.slice(0, 8), subscriptions);
	const allUsersWithState = await annotateUsersWithSubscriptionState(allUsers, subscriptions);
	const subscribedUsersCount = allUsersWithState.filter((user) => user.subscriptionState.subscribed).length;
	const notSubscribedUsersCount = allUsersWithState.filter((user) =>
		user.subscriptionState.hasRequirements && user.subscriptionState.missingCount > 0
	).length;
	const healthyUsersCount = allUsersWithState.filter((user) =>
		!user.is_blocked && user.subscriptionState.subscribed
	).length;

	renderAdmin(res, "dashboard", {
		activeNav: "dashboard",
		snapshot,
		usersCount,
		healthyUsersCount,
		subscribedUsersCount,
		notSubscribedUsersCount,
		manualBlockedUsersCount,
		messagesCount,
		latestUsers,
		requiredSubscriptions: subscriptions
	});
});

webApp.get("/admin", requireAdmin, async (req, res) => {
	return res.redirect("/");
});

webApp.get("/users", requireAdmin, async (req, res) => {
	const search = String(req.query.search || "").trim();
	const query = search
		? db.prepare(`
			SELECT * FROM users
			WHERE telegram_id LIKE ? OR username LIKE ? OR first_name LIKE ? OR last_name LIKE ?
			ORDER BY last_seen_at DESC
		`)
		: db.prepare("SELECT * FROM users ORDER BY last_seen_at DESC");
	const users = search
		? query.all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`)
		: query.all();

	renderAdmin(res, "users", {
		activeNav: "users",
		users: await annotateUsersWithSubscriptionState(users),
		search
	});
});

webApp.get("/users/:id", requireAdmin, async (req, res) => {
	const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
	if (!user) {
		return res.status(404).send("User not found");
	}

	const messages = db.prepare(`
		SELECT *
		FROM user_messages
		WHERE user_id = ?
		ORDER BY created_at DESC
		LIMIT 150
	`).all(user.id);
	const subscriptionState = await buildSubscriptionStateForUser(user);

	renderAdmin(res, "user-details", {
		activeNav: "users",
		user: {
			...user,
			subscriptionState,
			statusMeta: getStatusMeta(user, subscriptionState)
		},
		messages
	});
});

webApp.post("/users/:id/toggle-block", requireAdmin, (req, res) => {
	const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
	if (!user) {
		return res.redirect("/users");
	}

	if (user.is_blocked && user.block_reason === "manual") {
		db.prepare("UPDATE users SET is_blocked = 0, block_reason = '' WHERE id = ?").run(user.id);
		logAdminEvent("user_unblocked", { userId: user.id });
	} else {
		db.prepare("UPDATE users SET is_blocked = 1, block_reason = 'manual' WHERE id = ?").run(user.id);
		logAdminEvent("user_blocked", { userId: user.id });
	}

	const backTo = String(req.body.backTo || "list");
	return res.redirect(backTo === "details" ? `/users/${user.id}` : "/users");
});

webApp.post("/users/:id/send", requireAdmin, async (req, res) => {
	const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
	const text = String(req.body.text || "").trim();
	if (!user || !text) {
		return res.redirect(`/users/${req.params.id}`);
	}

	try {
		await sendTelegramHtml(user.telegram_id, text);
		logMessage(user.id, "out", "admin_reply", text);
	} catch (error) {
		logAdminEvent("admin_send_failed", { userId: user.id, error: error.message });
	}

	res.redirect(`/users/${req.params.id}`);
});

webApp.get("/broadcast", requireAdmin, (req, res) => {
	renderAdmin(res, "broadcast", {
		activeNav: "broadcast",
		lastEvent: db.prepare("SELECT * FROM admin_events ORDER BY created_at DESC LIMIT 1").get()
	});
});

webApp.post("/broadcast", requireAdmin, async (req, res) => {
	const text = String(req.body.text || "").trim();
	if (!text) {
		return res.redirect("/broadcast");
	}

	const users = db.prepare("SELECT * FROM users WHERE is_blocked = 0").all();
	let sentCount = 0;

	for (const user of users) {
		try {
			await sendTelegramHtml(user.telegram_id, text);
			logMessage(user.id, "out", "broadcast", text);
			sentCount++;
		} catch {
			db.prepare("UPDATE users SET is_blocked = 1, block_reason = 'delivery_failed' WHERE id = ?").run(user.id);
		}
	}

	logAdminEvent("broadcast", { text, sentCount });
	res.redirect("/broadcast");
});

webApp.get("/subscriptions", requireAdmin, (req, res) => {
	renderAdmin(res, "subscriptions", {
		activeNav: "subscriptions",
		subscriptions: config.requiredSubscriptions || [],
		reminderOptions: getReminderIntervalOptions(),
		getReminderIntervalLabel
	});
});

webApp.post("/subscriptions", requireAdmin, async (req, res) => {
	const title = String(req.body.title || "").trim();
	const url = String(req.body.url || "").trim();
	const reminderInterval = String(req.body.reminderInterval || "none").trim().toLowerCase();
	if (title && url) {
		config.requiredSubscriptions = config.requiredSubscriptions || [];
		config.requiredSubscriptions.push({
			id: crypto.randomBytes(6).toString("hex"),
			title,
			url,
			username: parseSubscriptionUsername(url),
			enabled: true,
			reminderInterval: ["minute", "hour", "day"].includes(reminderInterval) ? reminderInterval : "none"
		});
		saveConfig(config);
		await announceMandatorySubscriptionsChange();
	}

	res.redirect("/subscriptions");
});

webApp.post("/subscriptions/:id/toggle", requireAdmin, async (req, res) => {
	config.requiredSubscriptions = (config.requiredSubscriptions || []).map((item) =>
		item.id === req.params.id ? { ...item, enabled: !item.enabled } : item
	);
	deleteReminderBySubscriptionStmt.run(req.params.id);
	saveConfig(config);
	await announceMandatorySubscriptionsChange();
	res.redirect("/subscriptions");
});

webApp.post("/subscriptions/:id/reminder", requireAdmin, (req, res) => {
	const reminderInterval = String(req.body.reminderInterval || "none").trim().toLowerCase();
	config.requiredSubscriptions = (config.requiredSubscriptions || []).map((item) =>
		item.id === req.params.id
			? {
				...item,
				reminderInterval: ["minute", "hour", "day"].includes(reminderInterval) ? reminderInterval : "none"
			}
			: item
	);
	deleteReminderBySubscriptionStmt.run(req.params.id);
	saveConfig(config);
	res.redirect("/subscriptions");
});

webApp.post("/subscriptions/:id/delete", requireAdmin, async (req, res) => {
	config.requiredSubscriptions = (config.requiredSubscriptions || []).filter((item) => item.id !== req.params.id);
	deleteReminderBySubscriptionStmt.run(req.params.id);
	saveConfig(config);
	await announceMandatorySubscriptionsChange();
	res.redirect("/subscriptions");
});

webApp.get("/events", requireAdmin, (req, res) => {
	const snapshot = getSnapshot();
	renderAdmin(res, "events", {
		activeNav: "events",
		snapshot,
		flattened: snapshot.anarchies.flatMap((entry) =>
			entry.events.map((event) => ({
				anarchy: entry.anarchy,
				updatedAtLabel: entry.updatedAtLabel,
				...event
			}))
		)
	});
});

webApp.get("/settings", requireAdmin, (req, res) => {
	renderAdmin(res, "settings", {
		activeNav: "settings",
		config
	});
});

webApp.post("/settings", requireAdmin, (req, res) => {
	config.panelPort = Number(req.body.panelPort || config.panelPort);
	config.panelHost = String(req.body.panelHost || config.panelHost).trim() || config.panelHost;
	config.adminUsername = String(req.body.adminUsername || config.adminUsername).trim() || config.adminUsername;
	config.adminPassword = String(req.body.adminPassword || config.adminPassword).trim() || config.adminPassword;
	config.checkerLogPath = String(req.body.checkerLogPath || config.checkerLogPath).trim() || config.checkerLogPath;
	config.knownEvents = String(req.body.knownEvents || "")
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter(Boolean);
	saveConfig(config);
	res.redirect("/settings");
});

webApp.get("/site/login", (req, res) => {
	if (getSiteUserBySession(getSiteSession(req))) {
		return res.redirect("/site/app");
	}

	renderPortal(res, "portal-login", { error: "" });
});

webApp.post("/site/login", (req, res) => {
	const email = String(req.body.email || "").trim().toLowerCase();
	const password = String(req.body.password || "");
	const webUser = db.prepare("SELECT * FROM web_users WHERE lower(email) = ?").get(email);

	if (!webUser || !verifyPassword(password, webUser.password_hash)) {
		return renderPortal(res, "portal-login", {
			error: "РќРµРІРµСЂРЅС‹Р№ email РёР»Рё РїР°СЂРѕР»СЊ."
		});
	}

	db.prepare("UPDATE web_users SET last_login_at = ? WHERE id = ?").run(nowIso(), webUser.id);
	const token = randomToken();
	siteSessions.set(token, { webUserId: webUser.id, createdAt: nowIso() });
	setCookie(res, "site_session", token);
	return res.redirect("/site/app");
});

webApp.get("/site/register", (req, res) => {
	if (getSiteUserBySession(getSiteSession(req))) {
		return res.redirect("/site/app");
	}

	renderPortal(res, "portal-register", { error: "", values: {} });
});

webApp.post("/site/register", (req, res) => {
	const displayName = String(req.body.displayName || "").trim();
	const email = String(req.body.email || "").trim().toLowerCase();
	const password = String(req.body.password || "");
	const confirmPassword = String(req.body.confirmPassword || "");

	if (!displayName || !email || !password) {
		return renderPortal(res, "portal-register", {
			error: "Р—Р°РїРѕР»РЅРё РІСЃРµ РїРѕР»СЏ.",
			values: { displayName, email }
		});
	}

	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
		return renderPortal(res, "portal-register", {
			error: "РЈРєР°Р¶Рё РєРѕСЂСЂРµРєС‚РЅС‹Р№ email.",
			values: { displayName, email }
		});
	}

	if (password.length < 6) {
		return renderPortal(res, "portal-register", {
			error: "РџР°СЂРѕР»СЊ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РЅРµ РєРѕСЂРѕС‡Рµ 6 СЃРёРјРІРѕР»РѕРІ.",
			values: { displayName, email }
		});
	}

	if (password !== confirmPassword) {
		return renderPortal(res, "portal-register", {
			error: "РџР°СЂРѕР»Рё РЅРµ СЃРѕРІРїР°РґР°СЋС‚.",
			values: { displayName, email }
		});
	}

	const existing = db.prepare("SELECT id FROM web_users WHERE lower(email) = ?").get(email);
	if (existing) {
		return renderPortal(res, "portal-register", {
			error: "РўР°РєРѕР№ email СѓР¶Рµ Р·Р°СЂРµРіРёСЃС‚СЂРёСЂРѕРІР°РЅ.",
			values: { displayName, email }
		});
	}

	const result = db.prepare(`
		INSERT INTO web_users (email, display_name, password_hash, settings_json, created_at, last_login_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		email,
		displayName,
		hashPassword(password),
		JSON.stringify(DEFAULT_USER_SETTINGS),
		nowIso(),
		nowIso()
	);

	const token = randomToken();
	siteSessions.set(token, { webUserId: result.lastInsertRowid, createdAt: nowIso() });
	setCookie(res, "site_session", token);
	return res.redirect("/site/app");
});

webApp.post("/site/logout", requireSiteUser, (req, res) => {
	siteSessions.delete(getCookie(req, "site_session"));
	clearCookie(res, "site_session");
	res.redirect("/site");
});

webApp.get(["/eventbotfuntime", "/eventbotfuntime/", "/eventbotfuntime/site"], (req, res) => {
	res.redirect("/site");
});

webApp.get("/site", (req, res) => {
	const session = getSiteSession(req);
	const webUser = getSiteUserBySession(session);
	const snapshot = getSnapshot();

	renderPortal(res, "portal-landing", {
		activePortalNav: "landing",
		snapshot,
		subscriptions: listEnabledSubscriptions(),
		webUser
	});
});

webApp.get("/site/app", requireSiteUser, async (req, res) => {
	const portalState = await buildPortalPageState(req.webUser);
	const allEvents = portalState.accessState.allowed
		? formatEventCards(filterAndSortEvents(portalState.snapshot, portalState.settings, "all"))
		: [];
	const currentEvents = portalState.accessState.allowed
		? formatEventCards(filterAndSortEvents(portalState.snapshot, portalState.settings, "current"))
		: [];
	const upcomingEvents = portalState.accessState.allowed
		? formatEventCards(filterAndSortEvents(portalState.snapshot, portalState.settings, "upcoming"))
		: [];

	renderPortal(res, "portal-dashboard", {
		activePortalNav: "account",
		allEvents,
		currentEvents,
		upcomingEvents,
		...portalState
	});
});

webApp.get("/site/events", (req, res) => {
	res.redirect("/site/events/all");
});

webApp.get("/site/events/all", requireSiteUser, async (req, res) => {
	const portalState = await buildPortalPageState(req.webUser);
	const events = portalState.accessState.allowed
		? formatEventCards(filterAndSortEvents(portalState.snapshot, portalState.settings, "all"))
		: [];

	renderPortal(res, "portal-events", {
		activePortalNav: "events-all",
		mode: "all",
		pageHeading: "Все ивенты",
		pageDescription: "Здесь показывается полный список событий по всем анархиям с учетом твоих фильтров.",
		emptyText: "По текущим фильтрам подходящих ивентов сейчас нет.",
		events,
		...portalState
	});
});

webApp.get("/site/events/current", requireSiteUser, async (req, res) => {
	const portalState = await buildPortalPageState(req.webUser);
	const events = portalState.accessState.allowed
		? formatEventCards(filterAndSortEvents(portalState.snapshot, portalState.settings, "current"))
		: [];

	renderPortal(res, "portal-events", {
		activePortalNav: "events-current",
		mode: "current",
		pageHeading: "Текущие ивенты",
		pageDescription: "Здесь показываются только активные ивенты по всем отслеживаемым анархиям.",
		emptyText: "Активных ивентов по текущим фильтрам сейчас нет.",
		events,
		...portalState
	});
});

webApp.get("/site/events/upcoming", requireSiteUser, async (req, res) => {
	const portalState = await buildPortalPageState(req.webUser);
	const events = portalState.accessState.allowed
		? formatEventCards(filterAndSortEvents(portalState.snapshot, portalState.settings, "upcoming"))
		: [];

	renderPortal(res, "portal-events", {
		activePortalNav: "events-upcoming",
		mode: "upcoming",
		pageHeading: "Предстоящие ивенты",
		pageDescription: "Здесь показываются ближайшие ивенты и таймеры до их начала.",
		emptyText: "Предстоящих ивентов по текущим фильтрам сейчас нет.",
		events,
		...portalState
	});
});

webApp.post("/site/link", requireSiteUser, (req, res) => {
	const linkCode = createLinkCode();
	const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
	db.prepare("UPDATE web_users SET link_code = ?, link_code_expires_at = ? WHERE id = ?")
		.run(linkCode, expiresAt, req.webUser.id);
	res.redirect("/site/app");
});

webApp.get("/site/settings", requireSiteUser, async (req, res) => {
	const portalState = await buildPortalPageState(req.webUser);
	renderPortal(res, "portal-settings", {
		activePortalNav: "settings",
		catalog: getEventCatalog(portalState.snapshot),
		...portalState
	});
});

webApp.post("/site/settings", requireSiteUser, (req, res) => {
	const eventFiltersRaw = req.body.eventFilters;
	const eventFilters = Array.isArray(eventFiltersRaw)
		? eventFiltersRaw
		: (eventFiltersRaw ? [eventFiltersRaw] : []);
	setWebUserSettings(req.webUser.id, {
		activeOnly: req.body.activeOnly === "on",
		sortMode: [
			"time_asc",
			"time_desc",
			"anarchy_asc",
			"anarchy_desc"
		].includes(req.body.sortMode)
			? req.body.sortMode
			: (req.body.sortDirection === "desc" ? "time_desc" : "time_asc"),
		eventFilters
	});
	res.redirect("/site/settings");
});

bot.catch((error, ctx) => {
	console.error("Telegram update failed:", {
		updateType: ctx?.updateType,
		callbackData: ctx?.callbackQuery?.data,
		message: error?.message
	});
});

function launch() {
	webApp.listen(config.panelPort, config.panelHost, () => {
		console.log(`Admin panel: http://${config.panelHost}:${config.panelPort}`);
		console.log(`Portal: http://${config.panelHost}:${config.panelPort}/site`);
		console.log(`Checker log: ${config.checkerLogPath}`);
		console.log(`Snapshot source mode: ${config.snapshotSourceMode}`);
		console.log(`Event ingest: ${config.eventIngestToken ? "enabled" : "disabled"}`);
		console.log(`Telegram bot: ${String(config.botToken || "").trim() ? "enabled" : "disabled"}`);
	});

	setInterval(() => {
		processSubscriptionReminders().catch((error) => {
			console.error("Subscription reminder loop failed:", error.message);
		});
	}, 60 * 1000);

	if (String(config.botToken || "").trim()) {
		bot.launch()
			.then(() => {
				console.log("Telegram bot is running.");
			})
			.catch((error) => {
				console.error("Telegram bot launch failed:", error.message);
			});
	}
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

try {
	launch();
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}

