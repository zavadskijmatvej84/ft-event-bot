package ru.sergey.funtimewatcher.client;

import java.awt.Desktop;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.session.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import ru.sergey.funtimewatcher.client.mixin.MinecraftClientAccessor;

public final class FuntimeController {
	private static final Logger LOGGER = LoggerFactory.getLogger("funtimewatcher");
	private static final DateTimeFormatter TIME_FORMAT = DateTimeFormatter.ofPattern("HH:mm:ss");
	private static final String EVENT_DELAY_COMMAND = "/event delay";

	private final EventDelayParser parser = new EventDelayParser();
	private final Deque<String> logs = new ArrayDeque<>();
	private final Map<String, Long> priorityDeadlines = new LinkedHashMap<>();
	private final Map<String, Long> fullRetryDeadlines = new LinkedHashMap<>();
	private final Map<String, Integer> fullRetryAttempts = new HashMap<>();
	private final Map<String, String> lastReportedMessageByKey = new HashMap<>();
	private final List<String> pendingLines = new ArrayList<>();
	private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

	private FuntimeConfig config;
	private boolean running;
	private boolean warnedAboutMissingConnection;
	private Phase phase = Phase.IDLE;
	private int roundRobinIndex;
	private long nextActionAtMs;
	private String activeAnarchy = "";
	private boolean activePriority;
	private int activeFullRetries;
	private String status = "Idle";
	private String lastError = "";
	private String lastEventSummary = "-";
	private long nextAutoLoginAttemptAtMs;
	private String lastAuthPrompt = "";

	public FuntimeController(FuntimeConfig config) {
		this.config = config;
		log("Config path: " + config.getConfigPath());
	}

	public void reloadConfig() {
		config = FuntimeConfig.load();
		log("Config reloaded.");
	}

	public void start() {
		List<String> errors = config.validateForStart();
		if (!errors.isEmpty()) {
			lastError = String.join(" ", errors);
			status = "Config error";
			log(lastError);
			return;
		}

		running = true;
		warnedAboutMissingConnection = false;
		phase = Phase.IDLE;
		roundRobinIndex = 0;
		nextActionAtMs = 0L;
		activeAnarchy = "";
		activePriority = false;
		activeFullRetries = 0;
		priorityDeadlines.clear();
		fullRetryDeadlines.clear();
		fullRetryAttempts.clear();
		lastReportedMessageByKey.clear();
		pendingLines.clear();
		lastEventSummary = "-";
		lastError = "";
		nextAutoLoginAttemptAtMs = 0L;
		lastAuthPrompt = "";
		status = "Running";
		log("Watcher started for " + getSelectedAccountLabel() + ".");
	}

	public void stop() {
		running = false;
		phase = Phase.IDLE;
		nextActionAtMs = 0L;
		activeAnarchy = "";
		activePriority = false;
		activeFullRetries = 0;
		pendingLines.clear();
		status = "Stopped";
		log("Watcher stopped.");
	}

	public void onJoinServer() {
		warnedAboutMissingConnection = false;
		nextAutoLoginAttemptAtMs = 0L;
		lastAuthPrompt = "";
		log("Connected to a server.");
	}

	public void onLeaveServer() {
		phase = Phase.IDLE;
		nextActionAtMs = 0L;
		activeAnarchy = "";
		activePriority = false;
		activeFullRetries = 0;
		pendingLines.clear();
		status = running ? "Waiting for server" : "Stopped";
		nextAutoLoginAttemptAtMs = 0L;
		lastAuthPrompt = "";
		log("Disconnected from the server.");
	}

	public void onChatMessage(String message) {
		String sanitized = EventDelayParser.sanitize(message);
		if (sanitized.isBlank()) {
			return;
		}

		if (shouldAutoAuth(sanitized)) {
			lastAuthPrompt = sanitized;
			attemptAutoAuth(sanitized);
		}

		if (!running) {
			return;
		}

		if (phase == Phase.WAITING_FOR_ANARCHY_SWITCH && !activeAnarchy.isBlank() && isFullAnarchyMessage(sanitized)) {
			handleFullAnarchy(activeAnarchy);
			return;
		}

		if (phase == Phase.WAITING_FOR_EVENT_REPLY && parser.looksLikeEventReply(sanitized)) {
			pendingLines.add(sanitized);
		}
	}

	public void tick(MinecraftClient client) {
		if (!running) {
			return;
		}

		ClientPlayNetworkHandler networkHandler = client.getNetworkHandler();
		if (client.player == null || networkHandler == null) {
			status = "Waiting for server";
			if (!warnedAboutMissingConnection) {
				warnedAboutMissingConnection = true;
				log("Join the FunTime server first, then press Start.");
			}
			return;
		}

		warnedAboutMissingConnection = false;
		long now = System.currentTimeMillis();
		if (now < nextActionAtMs) {
			return;
		}

		switch (phase) {
			case IDLE -> beginAnarchyScan(client, now);
			case WAITING_FOR_ANARCHY_SWITCH -> requestEventDelay(client, now);
			case WAITING_FOR_EVENT_REPLY -> finishEventDelay(now);
		}
	}

	public boolean isRunning() {
		return running;
	}

	public String getStatus() {
		return status;
	}

	public String getLastError() {
		return lastError;
	}

	public String getLastEventSummary() {
		return lastEventSummary;
	}

	public List<String> getRecentLogs() {
		return List.copyOf(logs);
	}

	public FuntimeConfig getConfig() {
		return config;
	}

	public String getSelectedAccountLabel() {
		FuntimeConfig.AccountProfile profile = config.getSelectedAccountProfile();
		return profile == null ? "none" : profile.label();
	}

	public String getSelectedAccountLoginCommand() {
		FuntimeConfig.AccountProfile profile = config.getSelectedAccountProfile();
		return profile == null ? "" : profile.loginCommand();
	}

	public String getSelectedAccountRegisterCommand() {
		FuntimeConfig.AccountProfile profile = config.getSelectedAccountProfile();
		return profile == null ? "" : profile.registerCommand();
	}

	public String getSelectedAccountSessionUsername() {
		FuntimeConfig.AccountProfile profile = config.getSelectedAccountProfile();
		return profile == null ? "" : profile.sessionUsername();
	}

	public String getCurrentSessionUsername() {
		MinecraftClient client = MinecraftClient.getInstance();
		if (client == null || client.getSession() == null) {
			return "";
		}

		return client.getSession().getUsername();
	}

	public String getLastAuthPrompt() {
		return lastAuthPrompt;
	}

	public String getCurrentAnarchy() {
		return activeAnarchy.isBlank() ? "-" : activeAnarchy;
	}

	public int getPendingPriorityCount() {
		long now = System.currentTimeMillis();
		return (int) priorityDeadlines.values().stream().filter(deadline -> deadline <= now).count();
	}

	public int getPendingFullRetryCount() {
		return fullRetryDeadlines.size();
	}

	public int getActiveFullRetries() {
		return activeFullRetries;
	}

	public void selectPreviousAccount() {
		config = config.withSelectedAccountIndex(config.getSelectedAccountIndex() - 1);
		config.save();
		log("Selected account: " + getSelectedAccountLabel());
	}

	public void selectNextAccount() {
		config = config.withSelectedAccountIndex(config.getSelectedAccountIndex() + 1);
		config.save();
		log("Selected account: " + getSelectedAccountLabel());
	}

	public void applySelectedAccountSession() {
		FuntimeConfig.AccountProfile profile = config.getSelectedAccountProfile();
		if (profile == null || profile.sessionUsernameOrLabel().isBlank()) {
			lastError = "Selected profile has no session username.";
			status = "Config error";
			log(lastError);
			return;
		}

		MinecraftClient client = MinecraftClient.getInstance();
		Session session = new Session(
			profile.sessionUsernameOrLabel(),
			resolveUuid(profile),
			normalizeSecret(profile.sessionAccessToken()),
			toOptional(profile.sessionXuid()),
			toOptional(profile.sessionClientId()),
			resolveAccountType(profile.accountTypeName())
		);
		((MinecraftClientAccessor) (Object) client).funtimewatcher$setSession(session);
		log("Applied session for " + profile.sessionUsernameOrLabel() + ".");
	}

	public void openConfigFile() {
		try {
			if (Desktop.isDesktopSupported()) {
				Desktop.getDesktop().open(config.getConfigPath().toFile());
				log("Opened config file.");
			} else {
				log("Config file: " + config.getConfigPath());
			}
		} catch (IOException exception) {
			lastError = "Could not open config: " + exception.getMessage();
			log(lastError);
		}
	}

	private void beginAnarchyScan(MinecraftClient client, long now) {
		TargetSelection targetSelection = pickNextTarget(now);
		if (targetSelection == null) {
			status = "No anarchy targets";
			nextActionAtMs = now + ticksToMillis(config.getLoopPauseTicks());
			return;
		}

		activeAnarchy = targetSelection.anarchyCommand();
		activePriority = targetSelection.priority();
		activeFullRetries = fullRetryAttempts.getOrDefault(activeAnarchy, 0);
		pendingLines.clear();
		sendCommand(client, activeAnarchy);
		status = "Switching to " + activeAnarchy + (activePriority ? " [priority]" : targetSelection.fullRetry() ? " [retry]" : "");
		log("Sent " + activeAnarchy + ".");
		phase = Phase.WAITING_FOR_ANARCHY_SWITCH;
		nextActionAtMs = now + ticksToMillis(config.getAnarchySettleTicks());
	}

	private void requestEventDelay(MinecraftClient client, long now) {
		sendCommand(client, EVENT_DELAY_COMMAND);
		status = "Checking " + activeAnarchy;
		phase = Phase.WAITING_FOR_EVENT_REPLY;
		nextActionAtMs = now + ticksToMillis(config.getEventResponseWindowTicks());
		log("Sent " + EVENT_DELAY_COMMAND + " on " + activeAnarchy + ".");
	}

	private void finishEventDelay(long now) {
		EventDelayParser.ParsedEventResult result = parser.parse(List.copyOf(pendingLines), activeAnarchy);
		pendingLines.clear();
		lastEventSummary = result.messageText();
		rememberAndMaybeSend(result);
		sendSiteSync(result);

		if (result.timerMs() != null && result.timerMs() > 0) {
			priorityDeadlines.put(activeAnarchy, now + result.timerMs() + ticksToMillis(config.getPriorityOffsetTicks()));
		}

		fullRetryAttempts.remove(activeAnarchy);
		status = "Running";
		phase = Phase.IDLE;
		nextActionAtMs = now + ticksToMillis(config.getLoopPauseTicks());
		activeAnarchy = "";
		activePriority = false;
		activeFullRetries = 0;
	}

	private TargetSelection pickNextTarget(long now) {
		String readyPriority = priorityDeadlines.entrySet().stream()
			.filter(entry -> entry.getValue() <= now)
			.sorted(Map.Entry.comparingByValue())
			.map(Map.Entry::getKey)
			.findFirst()
			.orElse(null);
		if (readyPriority != null) {
			priorityDeadlines.remove(readyPriority);
			return new TargetSelection(readyPriority, true, false);
		}

		String readyRetry = fullRetryDeadlines.entrySet().stream()
			.filter(entry -> entry.getValue() <= now)
			.sorted(Map.Entry.comparingByValue())
			.map(Map.Entry::getKey)
			.findFirst()
			.orElse(null);
		if (readyRetry != null) {
			fullRetryDeadlines.remove(readyRetry);
			return new TargetSelection(readyRetry, false, true);
		}

		List<String> anarchies = config.getAnarchyCommands();
		if (anarchies.isEmpty()) {
			return null;
		}

		for (int step = 0; step < anarchies.size(); step++) {
			int index = (roundRobinIndex + step) % anarchies.size();
			String anarchy = anarchies.get(index);
			Long retryDeadline = fullRetryDeadlines.get(anarchy);
			if (retryDeadline != null && retryDeadline > now) {
				continue;
			}

			roundRobinIndex = (index + 1) % anarchies.size();
			return new TargetSelection(anarchy, false, false);
		}

		return null;
	}

	private void handleFullAnarchy(String anarchyCommand) {
		long now = System.currentTimeMillis();
		int attempts = fullRetryAttempts.getOrDefault(anarchyCommand, 0) + 1;
		if (attempts <= config.getMaxFullRetries()) {
			fullRetryAttempts.put(anarchyCommand, attempts);
			fullRetryDeadlines.put(anarchyCommand, now);
			activeFullRetries = attempts;
			status = "Retry " + attempts + "/" + config.getMaxFullRetries() + " for " + anarchyCommand;
			log(anarchyCommand + " is full, retry " + attempts + "/" + config.getMaxFullRetries() + ".");
		} else {
			fullRetryAttempts.remove(anarchyCommand);
			fullRetryDeadlines.put(anarchyCommand, now + ticksToMillis(config.getFullRetryCooldownTicks()));
			activeFullRetries = 0;
			status = "Cooldown for " + anarchyCommand;
			log(anarchyCommand + " is still full, retry in 1 minute.");
		}

		phase = Phase.IDLE;
		nextActionAtMs = now + ticksToMillis(config.getLoopPauseTicks());
		pendingLines.clear();
		activeAnarchy = "";
		activePriority = false;
	}

	private void rememberAndMaybeSend(EventDelayParser.ParsedEventResult result) {
		String key = result.anarchyCommand();
		String message = result.messageText();
		String previousMessage = lastReportedMessageByKey.get(key);
		lastReportedMessageByKey.put(key, message);

		boolean shouldSend = switch (config.getTelegramSendMode()) {
			case "all" -> true;
			case "changes" -> !message.equals(previousMessage);
			default -> !message.equals(previousMessage);
		};

		log(message);
		if (shouldSend) {
			sendTelegram(message);
		}
	}

	private void sendTelegram(String message) {
		if (!config.isTelegramEnabled()) {
			return;
		}

		String botToken = normalizeSecret(config.getTelegramBotToken());
		String chatId = normalizeSecret(config.getTelegramChatId());
		if (botToken.isBlank() || chatId.isBlank()) {
			return;
		}

		String payload = "{\"chat_id\":\"" + escapeJson(chatId) + "\",\"text\":\"" + escapeJson(message) + "\"}";
		HttpRequest request = HttpRequest.newBuilder()
			.uri(URI.create("https://api.telegram.org/bot" + botToken + "/sendMessage"))
			.header("Content-Type", "application/json")
			.timeout(Duration.ofSeconds(15))
			.POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
			.build();

		httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString())
			.thenAccept(response -> {
				if (response.statusCode() >= 400) {
					log("Telegram send failed: " + response.statusCode() + " " + response.body());
				}
			})
			.exceptionally(throwable -> {
				log("Telegram send failed: " + throwable.getMessage());
				return null;
			});
	}

	private void sendSiteSync(EventDelayParser.ParsedEventResult result) {
		if (!config.isSiteSyncEnabled()) {
			return;
		}

		String syncUrl = normalizeSecret(config.getSiteSyncUrl());
		String syncToken = normalizeSecret(config.getSiteSyncToken());
		if (syncUrl.isBlank() || syncToken.isBlank()) {
			return;
		}

		String payload = "{"
			+ "\"anarchy\":\"" + escapeJson(result.anarchyCommand()) + "\","
			+ "\"summaryText\":\"" + escapeJson(result.messageText()) + "\","
			+ "\"updatedAt\":\"" + escapeJson(Instant.now().toString()) + "\","
			+ "\"rawLines\":" + jsonArray(result.rawLines())
			+ "}";

		HttpRequest request = HttpRequest.newBuilder()
			.uri(URI.create(syncUrl))
			.header("Content-Type", "application/json")
			.header("Authorization", "Bearer " + syncToken)
			.timeout(Duration.ofSeconds(15))
			.POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
			.build();

		httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString())
			.thenAccept(response -> {
				if (response.statusCode() >= 400) {
					log("Site sync failed: " + response.statusCode() + " " + response.body());
				}
			})
			.exceptionally(throwable -> {
				log("Site sync failed: " + throwable.getMessage());
				return null;
			});
	}

	private boolean shouldAutoAuth(String message) {
		String lower = message.toLowerCase(Locale.ROOT);
		return lower.contains("/login")
			|| lower.contains("/register")
			|| lower.contains("войдите")
			|| lower.contains("авториз")
			|| lower.contains("зарегистр")
			|| lower.contains("login")
			|| lower.contains("register");
	}

	private void attemptAutoAuth(String message) {
		if (!running || !config.isAutoLoginEnabled()) {
			return;
		}

		long now = System.currentTimeMillis();
		if (now < nextAutoLoginAttemptAtMs) {
			return;
		}

		MinecraftClient client = MinecraftClient.getInstance();
		if (client.player == null || client.getNetworkHandler() == null) {
			return;
		}

		String authCommand = resolveAuthCommand(message);
		if (authCommand.isBlank()) {
			return;
		}

		sendCommand(client, authCommand);
		nextAutoLoginAttemptAtMs = now + 5000L;
		log("Auto auth sent for " + getSelectedAccountLabel() + ".");
	}

	private String resolveAuthCommand(String message) {
		String lower = message.toLowerCase(Locale.ROOT);
		boolean registerPrompt = lower.contains("/register") || lower.contains("register");
		String authCommand = registerPrompt ? getSelectedAccountRegisterCommand() : getSelectedAccountLoginCommand();
		if (authCommand.isBlank()) {
			return "";
		}

		if (authCommand.equalsIgnoreCase("/login password") || authCommand.equalsIgnoreCase("/register password password")) {
			lastError = "Set real auth commands for the selected profile.";
			status = "Config error";
			log(lastError);
			return "";
		}

		return authCommand;
	}

	private boolean isFullAnarchyMessage(String message) {
		String lower = message.toLowerCase(Locale.ROOT);
		return lower.contains("переполн")
			|| lower.contains("заполнен")
			|| lower.contains("мест нет")
			|| lower.contains("нет мест")
			|| lower.contains("слот");
	}

	private void sendCommand(MinecraftClient client, String command) {
		ClientPlayNetworkHandler networkHandler = client.getNetworkHandler();
		if (networkHandler == null) {
			return;
		}

		if (command.startsWith("/")) {
			networkHandler.sendChatCommand(command.substring(1));
		} else {
			networkHandler.sendChatMessage(command);
		}
	}

	private void log(String message) {
		String line = "[" + TIME_FORMAT.format(LocalTime.now()) + "] " + message;
		LOGGER.info(message);
		logs.addLast(line);
		while (logs.size() > 64) {
			logs.removeFirst();
		}
	}

	private static Optional<String> toOptional(String value) {
		String normalized = normalizeSecret(value);
		return normalized.isBlank() ? Optional.empty() : Optional.of(normalized);
	}

	private static String normalizeSecret(String value) {
		String normalized = value == null ? "" : value.trim();
		return "CHANGE_ME".equalsIgnoreCase(normalized) ? "" : normalized;
	}

	private static UUID resolveUuid(FuntimeConfig.AccountProfile profile) {
		String sessionUuid = profile.sessionUuid().trim();
		if (!sessionUuid.isBlank() && !"CHANGE_ME".equalsIgnoreCase(sessionUuid)) {
			try {
				return UUID.fromString(sessionUuid);
			} catch (IllegalArgumentException ignored) {
			}
		}

		return UUID.nameUUIDFromBytes(("OfflinePlayer:" + profile.sessionUsernameOrLabel()).getBytes(StandardCharsets.UTF_8));
	}

	private static Session.AccountType resolveAccountType(String accountTypeName) {
		String normalized = accountTypeName == null ? "" : accountTypeName.trim().toLowerCase(Locale.ROOT);
		Session.AccountType accountType = Session.AccountType.byName(normalized);
		return accountType == null ? Session.AccountType.LEGACY : accountType;
	}

	private static long ticksToMillis(int ticks) {
		return ticks * 50L;
	}

	private static String escapeJson(String value) {
		return value
			.replace("\\", "\\\\")
			.replace("\"", "\\\"")
			.replace("\n", "\\n")
			.replace("\r", "\\r");
	}

	private static String jsonArray(List<String> values) {
		StringBuilder builder = new StringBuilder("[");
		for (int index = 0; index < values.size(); index++) {
			if (index > 0) {
				builder.append(',');
			}

			builder.append('"').append(escapeJson(values.get(index))).append('"');
		}

		return builder.append(']').toString();
	}

	private enum Phase {
		IDLE,
		WAITING_FOR_ANARCHY_SWITCH,
		WAITING_FOR_EVENT_REPLY
	}

	private record TargetSelection(String anarchyCommand, boolean priority, boolean fullRetry) {
	}
}
