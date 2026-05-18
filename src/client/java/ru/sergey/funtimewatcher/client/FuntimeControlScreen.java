package ru.sergey.funtimewatcher.client;

import java.util.List;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

public final class FuntimeControlScreen extends Screen {
	private final FuntimeController controller;
	private ButtonWidget startButton;
	private ButtonWidget stopButton;
	private ButtonWidget previousAccountButton;
	private ButtonWidget nextAccountButton;
	private ButtonWidget applyAccountButton;

	public FuntimeControlScreen(FuntimeController controller) {
		super(Text.literal("Funtime Event Watcher"));
		this.controller = controller;
	}

	@Override
	protected void init() {
		int panelWidth = 392;
		int left = (width - panelWidth) / 2;
		int top = 30;

		startButton = addDrawableChild(
			ButtonWidget.builder(Text.literal("Start"), button -> controller.start())
				.dimensions(left, top + 44, 104, 20)
				.build()
		);
		stopButton = addDrawableChild(
			ButtonWidget.builder(Text.literal("Stop"), button -> controller.stop())
				.dimensions(left + 112, top + 44, 104, 20)
				.build()
		);
		addDrawableChild(
			ButtonWidget.builder(Text.literal("Reload config"), button -> controller.reloadConfig())
				.dimensions(left + 224, top + 44, 168, 20)
				.build()
		);
		addDrawableChild(
			ButtonWidget.builder(Text.literal("Open config"), button -> controller.openConfigFile())
				.dimensions(left, top + 70, 118, 20)
				.build()
		);
		previousAccountButton = addDrawableChild(
			ButtonWidget.builder(Text.literal("<"), button -> controller.selectPreviousAccount())
				.dimensions(left + 126, top + 70, 20, 20)
				.build()
		);
		nextAccountButton = addDrawableChild(
			ButtonWidget.builder(Text.literal(">"), button -> controller.selectNextAccount())
				.dimensions(left + 372, top + 70, 20, 20)
				.build()
		);
		applyAccountButton = addDrawableChild(
			ButtonWidget.builder(Text.literal("Apply account"), button -> controller.applySelectedAccountSession())
				.dimensions(left + 154, top + 96, 146, 20)
				.build()
		);

		updateButtonStates();
	}

	@Override
	public void render(DrawContext context, int mouseX, int mouseY, float delta) {
		context.fill(0, 0, width, height, 0x70101013);
		updateButtonStates();

		int panelWidth = 392;
		int panelHeight = 242;
		int left = (width - panelWidth) / 2;
		int top = 30;
		context.fill(left - 12, top - 12, left + panelWidth + 12, top + panelHeight + 220, 0xCC14171F);

		context.drawTextWithShadow(textRenderer, title, left, top, 0xFFFFFF);
		context.drawTextWithShadow(textRenderer, Text.literal("Open/close: Right Shift"), left, top + 16, 0xA7B1CA);
		context.drawTextWithShadow(textRenderer, Text.literal("Status: " + controller.getStatus()), left, top + 28, 0x7DFFC8);
		context.drawTextWithShadow(textRenderer, Text.literal("Current anarchy: " + controller.getCurrentAnarchy()), left + 205, top + 28, 0xDCF2F5);
		context.drawTextWithShadow(textRenderer, Text.literal("Priority queue ready: " + controller.getPendingPriorityCount()), left + 205, top + 40, 0xDCF2F5);
		context.drawTextWithShadow(textRenderer, Text.literal("Full retry queue: " + controller.getPendingFullRetryCount()), left + 205, top + 52, 0xDCF2F5);
		context.drawTextWithShadow(textRenderer, Text.literal("Active retry count: " + controller.getActiveFullRetries()), left + 205, top + 64, 0xDCF2F5);
		context.drawTextWithShadow(textRenderer, Text.literal("Selected profile: " + controller.getSelectedAccountLabel()), left + 154, top + 74, 0xFFFFFF);
		context.drawTextWithShadow(textRenderer, Text.literal("Session in game: " + trim("Session in game: " + controller.getCurrentSessionUsername(), 226)), left, top + 128, 0xDCF2F5);
		context.drawTextWithShadow(textRenderer, Text.literal("Last summary: " + trim(controller.getLastEventSummary(), 350)), left, top + 142, 0xDCF2F5);
		context.drawTextWithShadow(textRenderer, Text.literal("Reconnect after Apply account"), left + 154, top + 112, 0xFFD07C);

		String loginCommand = controller.getSelectedAccountLoginCommand();
		if (!loginCommand.isBlank()) {
			context.drawTextWithShadow(textRenderer, Text.literal("Login: " + trim(loginCommand, 236)), left, top + 154, 0xA7B1CA);
		}

		String registerCommand = controller.getSelectedAccountRegisterCommand();
		if (!registerCommand.isBlank()) {
			context.drawTextWithShadow(textRenderer, Text.literal("Register: " + trim(registerCommand, 226)), left, top + 166, 0xA7B1CA);
		}

		String lastError = controller.getLastError();
		if (!lastError.isBlank()) {
			context.drawTextWithShadow(textRenderer, Text.literal(lastError), left, top + 182, 0xFF7F7C);
		}

		String lastAuthPrompt = controller.getLastAuthPrompt();
		if (!lastAuthPrompt.isBlank()) {
			context.drawTextWithShadow(textRenderer, Text.literal("Auth prompt: " + trim(lastAuthPrompt, 344)), left, top + 194, 0xA7B1CA);
		}

		context.drawTextWithShadow(textRenderer, Text.literal("Config: " + controller.getConfig().getConfigPath()), left, top + 208, 0xA7B1CA);
		context.drawTextWithShadow(textRenderer, Text.literal("Recent logs:"), left, top + 228, 0xFFFFFF);

		List<String> recentLogs = controller.getRecentLogs();
		int logY = top + 242;
		int fromIndex = Math.max(0, recentLogs.size() - 13);
		for (int index = fromIndex; index < recentLogs.size(); index++) {
			context.drawTextWithShadow(textRenderer, trim(recentLogs.get(index), panelWidth + 12), left, logY, 0xDCF2F5);
			logY += 12;
		}

		super.render(context, mouseX, mouseY, delta);
	}

	@Override
	public boolean keyPressed(int keyCode, int scanCode, int modifiers) {
		if (keyCode == GLFW.GLFW_KEY_ESCAPE || keyCode == GLFW.GLFW_KEY_RIGHT_SHIFT) {
			close();
			return true;
		}

		return super.keyPressed(keyCode, scanCode, modifiers);
	}

	@Override
	public void close() {
		MinecraftClient.getInstance().setScreen(null);
	}

	@Override
	public boolean shouldPause() {
		return false;
	}

	private void updateButtonStates() {
		if (startButton != null) {
			startButton.active = !controller.isRunning();
		}
		if (stopButton != null) {
			stopButton.active = controller.isRunning();
		}

		boolean hasMultipleProfiles = controller.getConfig().getAccountProfiles().size() > 1;
		if (previousAccountButton != null) {
			previousAccountButton.active = hasMultipleProfiles;
		}
		if (nextAccountButton != null) {
			nextAccountButton.active = hasMultipleProfiles;
		}
		if (applyAccountButton != null) {
			applyAccountButton.active = !controller.getSelectedAccountSessionUsername().isBlank();
		}
	}

	private String trim(String value, int width) {
		return textRenderer.trimToWidth(value, width);
	}
}
