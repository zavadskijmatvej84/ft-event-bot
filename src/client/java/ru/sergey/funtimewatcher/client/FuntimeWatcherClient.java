package ru.sergey.funtimewatcher.client;

import com.mojang.authlib.GameProfile;
import java.time.Instant;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.network.message.MessageType;
import net.minecraft.network.message.SignedMessage;
import net.minecraft.text.Text;
import org.jetbrains.annotations.Nullable;
import org.lwjgl.glfw.GLFW;

public final class FuntimeWatcherClient implements ClientModInitializer {
	private static final String KEY_CATEGORY = "key.categories.funtimewatcher";
	private static final String OPEN_SCREEN_KEY = "key.funtimewatcher.open_screen";

	private static FuntimeController controller;
	private static KeyBinding openScreenBinding;

	public static FuntimeController getController() {
		return controller;
	}

	@Override
	public void onInitializeClient() {
		controller = new FuntimeController(FuntimeConfig.load());

		openScreenBinding = KeyBindingHelper.registerKeyBinding(
			new KeyBinding(OPEN_SCREEN_KEY, InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_RIGHT_SHIFT, KEY_CATEGORY)
		);

		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			while (openScreenBinding.wasPressed()) {
				client.setScreen(new FuntimeControlScreen(controller));
			}

			controller.tick(client);
		});

		ClientReceiveMessageEvents.GAME.register((message, overlay) -> controller.onChatMessage(message.getString()));
		ClientReceiveMessageEvents.CHAT.register(this::onChatMessage);
		ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> controller.onJoinServer());
		ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> controller.onLeaveServer());
		ScreenEvents.AFTER_INIT.register((client, screen, scaledWidth, scaledHeight) -> {
			if (!(screen instanceof TitleScreen)) {
				return;
			}

			Screens.getButtons(screen).add(
				ButtonWidget.builder(Text.literal("Event Bot"), button -> client.setScreen(new FuntimeControlScreen(controller)))
					.dimensions(scaledWidth / 2 - 100, scaledHeight / 4 + 96, 200, 20)
					.build()
			);
		});
	}

	private void onChatMessage(net.minecraft.text.Text message, @Nullable SignedMessage signedMessage, @Nullable GameProfile sender, MessageType.Parameters params, Instant receptionTimestamp) {
		controller.onChatMessage(message.getString());
	}
}
