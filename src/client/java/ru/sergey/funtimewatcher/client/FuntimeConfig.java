package ru.sergey.funtimewatcher.client;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Properties;
import net.fabricmc.loader.api.FabricLoader;

public final class FuntimeConfig {
	private static final String DEFAULT_ANARCHIES = defaultAnarchies();
	private static final String DEFAULT_ACCOUNT_PROFILES = "main|PlayerOne|||||LEGACY|/login password|/register password password";

	private final Path configPath;
	private final List<String> anarchyCommands;
	private final int anarchySettleTicks;
	private final int eventResponseWindowTicks;
	private final int loopPauseTicks;
	private final int priorityOffsetTicks;
	private final int maxFullRetries;
	private final int fullRetryCooldownTicks;
	private final boolean telegramEnabled;
	private final String telegramBotToken;
	private final String telegramChatId;
	private final String telegramSendMode;
	private final List<AccountProfile> accountProfiles;
	private final int selectedAccountIndex;
	private final boolean autoLoginEnabled;
	private final boolean siteSyncEnabled;
	private final String siteSyncUrl;
	private final String siteSyncToken;

	private FuntimeConfig(
		Path configPath,
		List<String> anarchyCommands,
		int anarchySettleTicks,
		int eventResponseWindowTicks,
		int loopPauseTicks,
		int priorityOffsetTicks,
		int maxFullRetries,
		int fullRetryCooldownTicks,
		boolean telegramEnabled,
		String telegramBotToken,
		String telegramChatId,
		String telegramSendMode,
		List<AccountProfile> accountProfiles,
		int selectedAccountIndex,
		boolean autoLoginEnabled,
		boolean siteSyncEnabled,
		String siteSyncUrl,
		String siteSyncToken
	) {
		this.configPath = configPath;
		this.anarchyCommands = List.copyOf(anarchyCommands);
		this.anarchySettleTicks = anarchySettleTicks;
		this.eventResponseWindowTicks = eventResponseWindowTicks;
		this.loopPauseTicks = loopPauseTicks;
		this.priorityOffsetTicks = priorityOffsetTicks;
		this.maxFullRetries = maxFullRetries;
		this.fullRetryCooldownTicks = fullRetryCooldownTicks;
		this.telegramEnabled = telegramEnabled;
		this.telegramBotToken = telegramBotToken;
		this.telegramChatId = telegramChatId;
		this.telegramSendMode = telegramSendMode;
		this.accountProfiles = List.copyOf(accountProfiles);
		this.selectedAccountIndex = selectedAccountIndex;
		this.autoLoginEnabled = autoLoginEnabled;
		this.siteSyncEnabled = siteSyncEnabled;
		this.siteSyncUrl = siteSyncUrl;
		this.siteSyncToken = siteSyncToken;
	}

	public static FuntimeConfig load() {
		Path configPath = FabricLoader.getInstance().getConfigDir().resolve("funtime-event-watcher.properties");
		Properties properties = new Properties();

		properties.setProperty("anarchy_commands", DEFAULT_ANARCHIES);
		properties.setProperty("anarchy_settle_ticks", "40");
		properties.setProperty("event_response_window_ticks", "20");
		properties.setProperty("loop_pause_ticks", "4");
		properties.setProperty("priority_offset_ticks", "100");
		properties.setProperty("max_full_retries", "5");
		properties.setProperty("full_retry_cooldown_ticks", "1200");
		properties.setProperty("telegram_enabled", "false");
		properties.setProperty("telegram_bot_token", "CHANGE_ME");
		properties.setProperty("telegram_chat_id", "CHANGE_ME");
		properties.setProperty("telegram_send_mode", "changes");
		properties.setProperty("account_profiles", DEFAULT_ACCOUNT_PROFILES);
		properties.setProperty("selected_account_index", "0");
		properties.setProperty("auto_login_enabled", "true");
		properties.setProperty("site_sync_enabled", "false");
		properties.setProperty("site_sync_url", "http://127.0.0.1:3080/api/ingest/event-delay");
		properties.setProperty("site_sync_token", "CHANGE_ME");

		if (Files.exists(configPath)) {
			try (InputStream inputStream = Files.newInputStream(configPath)) {
				properties.load(inputStream);
			} catch (IOException ignored) {
			}
		} else {
			try {
				Files.createDirectories(configPath.getParent());
			} catch (IOException ignored) {
			}
		}

		FuntimeConfig config = new FuntimeConfig(
			configPath,
			parseAnarchyCommands(properties.getProperty("anarchy_commands", DEFAULT_ANARCHIES)),
			parseInt(properties.getProperty("anarchy_settle_ticks"), 40),
			parseInt(properties.getProperty("event_response_window_ticks"), 20),
			parseInt(properties.getProperty("loop_pause_ticks"), 4),
			parseInt(properties.getProperty("priority_offset_ticks"), 100),
			parseInt(properties.getProperty("max_full_retries"), 5),
			parseInt(properties.getProperty("full_retry_cooldown_ticks"), 1200),
			Boolean.parseBoolean(properties.getProperty("telegram_enabled", "false")),
			properties.getProperty("telegram_bot_token", "CHANGE_ME").trim(),
			properties.getProperty("telegram_chat_id", "CHANGE_ME").trim(),
			properties.getProperty("telegram_send_mode", "changes").trim().toLowerCase(),
			parseAccountProfiles(properties.getProperty("account_profiles", DEFAULT_ACCOUNT_PROFILES)),
			parseInt(properties.getProperty("selected_account_index"), 0),
			Boolean.parseBoolean(properties.getProperty("auto_login_enabled", "true")),
			Boolean.parseBoolean(properties.getProperty("site_sync_enabled", "false")),
			properties.getProperty("site_sync_url", "http://127.0.0.1:3080/api/ingest/event-delay").trim(),
			properties.getProperty("site_sync_token", "CHANGE_ME").trim()
		);

		config.save();
		return config;
	}

	public void save() {
		Properties properties = new Properties();
		properties.setProperty("anarchy_commands", String.join(",", anarchyCommands));
		properties.setProperty("anarchy_settle_ticks", Integer.toString(anarchySettleTicks));
		properties.setProperty("event_response_window_ticks", Integer.toString(eventResponseWindowTicks));
		properties.setProperty("loop_pause_ticks", Integer.toString(loopPauseTicks));
		properties.setProperty("priority_offset_ticks", Integer.toString(priorityOffsetTicks));
		properties.setProperty("max_full_retries", Integer.toString(maxFullRetries));
		properties.setProperty("full_retry_cooldown_ticks", Integer.toString(fullRetryCooldownTicks));
		properties.setProperty("telegram_enabled", Boolean.toString(telegramEnabled));
		properties.setProperty("telegram_bot_token", telegramBotToken);
		properties.setProperty("telegram_chat_id", telegramChatId);
		properties.setProperty("telegram_send_mode", telegramSendMode);
		properties.setProperty("account_profiles", serializeAccountProfiles(accountProfiles));
		properties.setProperty("selected_account_index", Integer.toString(selectedAccountIndex));
		properties.setProperty("auto_login_enabled", Boolean.toString(autoLoginEnabled));
		properties.setProperty("site_sync_enabled", Boolean.toString(siteSyncEnabled));
		properties.setProperty("site_sync_url", siteSyncUrl);
		properties.setProperty("site_sync_token", siteSyncToken);

		try (OutputStream outputStream = Files.newOutputStream(configPath)) {
			properties.store(outputStream, "Funtime Event Watcher config");
		} catch (IOException ignored) {
		}
	}

	public List<String> validateForStart() {
		List<String> errors = new ArrayList<>();

		if (anarchyCommands.isEmpty()) {
			errors.add("Anarchy list is empty.");
		}

		if (accountProfiles.isEmpty()) {
			errors.add("Account profile list is empty.");
		}

		if (telegramEnabled) {
			if (telegramBotToken.isBlank() || telegramBotToken.equals("CHANGE_ME")) {
				errors.add("telegram_bot_token is missing.");
			}

			if (telegramChatId.isBlank() || telegramChatId.equals("CHANGE_ME")) {
				errors.add("telegram_chat_id is missing.");
			}
		}

		if (siteSyncEnabled) {
			if (siteSyncUrl.isBlank()) {
				errors.add("site_sync_url is missing.");
			}

			if (siteSyncToken.isBlank() || siteSyncToken.equals("CHANGE_ME")) {
				errors.add("site_sync_token is missing.");
			}
		}

		return errors;
	}

	public Path getConfigPath() {
		return configPath;
	}

	public List<String> getAnarchyCommands() {
		return anarchyCommands;
	}

	public int getAnarchySettleTicks() {
		return anarchySettleTicks;
	}

	public int getEventResponseWindowTicks() {
		return eventResponseWindowTicks;
	}

	public int getLoopPauseTicks() {
		return loopPauseTicks;
	}

	public int getPriorityOffsetTicks() {
		return priorityOffsetTicks;
	}

	public int getMaxFullRetries() {
		return maxFullRetries;
	}

	public int getFullRetryCooldownTicks() {
		return fullRetryCooldownTicks;
	}

	public boolean isTelegramEnabled() {
		return telegramEnabled;
	}

	public String getTelegramBotToken() {
		return telegramBotToken;
	}

	public String getTelegramChatId() {
		return telegramChatId;
	}

	public String getTelegramSendMode() {
		return telegramSendMode;
	}

	public List<AccountProfile> getAccountProfiles() {
		return accountProfiles;
	}

	public int getSelectedAccountIndex() {
		return selectedAccountIndex;
	}

	public boolean isAutoLoginEnabled() {
		return autoLoginEnabled;
	}

	public boolean isSiteSyncEnabled() {
		return siteSyncEnabled;
	}

	public String getSiteSyncUrl() {
		return siteSyncUrl;
	}

	public String getSiteSyncToken() {
		return siteSyncToken;
	}

	public AccountProfile getSelectedAccountProfile() {
		if (accountProfiles.isEmpty()) {
			return null;
		}

		int safeIndex = Math.floorMod(selectedAccountIndex, accountProfiles.size());
		return accountProfiles.get(safeIndex);
	}

	public FuntimeConfig withSelectedAccountIndex(int newIndex) {
		int safeIndex = accountProfiles.isEmpty() ? 0 : Math.floorMod(newIndex, accountProfiles.size());
		return new FuntimeConfig(
			configPath,
			anarchyCommands,
			anarchySettleTicks,
			eventResponseWindowTicks,
			loopPauseTicks,
			priorityOffsetTicks,
			maxFullRetries,
			fullRetryCooldownTicks,
			telegramEnabled,
			telegramBotToken,
			telegramChatId,
			telegramSendMode,
			accountProfiles,
			safeIndex,
			autoLoginEnabled,
			siteSyncEnabled,
			siteSyncUrl,
			siteSyncToken
		);
	}

	private static List<String> parseAnarchyCommands(String rawValue) {
		List<String> commands = new ArrayList<>();

		for (String chunk : rawValue.split(",")) {
			String value = chunk.trim();
			if (value.isEmpty()) {
				continue;
			}

			if (value.contains("-")) {
				List<String> expanded = expandRange(value);
				if (!expanded.isEmpty()) {
					commands.addAll(expanded);
					continue;
				}
			}

			commands.add(normalizeAnarchyCommand(value));
		}

		return commands;
	}

	private static List<String> expandRange(String rawValue) {
		String[] parts = rawValue.split("-", 2);
		if (parts.length != 2) {
			return List.of();
		}

		int start = parseAnarchyNumber(parts[0]);
		int end = parseAnarchyNumber(parts[1]);
		if (start <= 0 || end <= 0 || end < start) {
			return List.of();
		}

		List<String> expanded = new ArrayList<>();
		for (int value = start; value <= end; value++) {
			expanded.add("/an" + value);
		}

		return expanded;
	}

	private static int parseAnarchyNumber(String rawValue) {
		String digits = rawValue.trim().toLowerCase()
			.replace("/an", "")
			.replace("an", "")
			.replaceAll("[^0-9]", "");

		return parseInt(digits, -1);
	}

	private static String normalizeAnarchyCommand(String rawValue) {
		String value = rawValue.trim();
		if (value.startsWith("/an")) {
			return value;
		}

		if (value.startsWith("an")) {
			return "/" + value;
		}

		return "/an" + value;
	}

	private static int parseInt(String rawValue, int fallback) {
		try {
			return Integer.parseInt(rawValue);
		} catch (NumberFormatException ignored) {
			return fallback;
		}
	}

	private static String[] range(int start, int end) {
		String[] values = new String[end - start + 1];

		for (int value = start; value <= end; value++) {
			values[value - start] = "/an" + value;
		}

		return values;
	}

	private static String defaultAnarchies() {
		List<String> values = new ArrayList<>();
		Collections.addAll(values, range(101, 114));
		Collections.addAll(values, range(201, 236));
		Collections.addAll(values, range(301, 323));
		Collections.addAll(values, range(501, 514));
		Collections.addAll(values, range(901, 904));
		return String.join(",", values);
	}

	private static List<AccountProfile> parseAccountProfiles(String rawValue) {
		List<AccountProfile> profiles = new ArrayList<>();

		for (String chunk : rawValue.split(";")) {
			String value = chunk.trim();
			if (value.isEmpty()) {
				continue;
			}

			String[] parts = value.split("\\|", -1);
			if (parts.length <= 3) {
				String label = safePart(parts, 0, "main");
				String loginCommand = safePart(parts, 1, "");
				String registerCommand = safePart(parts, 2, "");
				profiles.add(new AccountProfile(label, label, "", "", "", "", "LEGACY", loginCommand, registerCommand));
				continue;
			}

			profiles.add(new AccountProfile(
				safePart(parts, 0, "main"),
				safePart(parts, 1, ""),
				safePart(parts, 2, ""),
				safePart(parts, 3, ""),
				safePart(parts, 4, ""),
				safePart(parts, 5, ""),
				safePart(parts, 6, "LEGACY"),
				safePart(parts, 7, ""),
				safePart(parts, 8, "")
			));
		}

		if (profiles.isEmpty()) {
			profiles.add(new AccountProfile("main", "PlayerOne", "", "", "", "", "LEGACY", "/login password", "/register password password"));
		}

		return profiles;
	}

	private static String safePart(String[] parts, int index, String fallback) {
		if (index >= parts.length) {
			return fallback;
		}

		String value = parts[index].trim();
		return value.isEmpty() ? fallback : value;
	}

	private static String serializeAccountProfiles(List<AccountProfile> profiles) {
		List<String> entries = new ArrayList<>();

		for (AccountProfile profile : profiles) {
			entries.add(String.join(
				"|",
				profile.label(),
				profile.sessionUsername(),
				profile.sessionUuid(),
				profile.sessionAccessToken(),
				profile.sessionXuid(),
				profile.sessionClientId(),
				profile.accountTypeName(),
				profile.loginCommand(),
				profile.registerCommand()
			));
		}

		return String.join(";", entries);
	}

	public record AccountProfile(
		String label,
		String sessionUsername,
		String sessionUuid,
		String sessionAccessToken,
		String sessionXuid,
		String sessionClientId,
		String accountTypeName,
		String loginCommand,
		String registerCommand
	) {
		public String sessionUsernameOrLabel() {
			return sessionUsername.isBlank() ? label : sessionUsername;
		}
	}
}
