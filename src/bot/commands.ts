import { SlashCommandBuilder, REST, Routes, EmbedBuilder } from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';
import { SessionState } from '../types/index.js';

export class CommandHandler {
  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string
  ) {}

  getCommands() {
    return [
      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the current Claude Code session"),
        
      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show the current session status"),
        
      new SlashCommandBuilder()
        .setName("pause")
        .setDescription("Pause the current active session"),
        
      new SlashCommandBuilder()
        .setName("resume")
        .setDescription("Resume the current paused session"),
        
      new SlashCommandBuilder()
        .setName("abort")
        .setDescription("Abort the current active session"),
    ];
  }

  async registerCommands(token: string, clientId: string): Promise<void> {
    const rest = new REST().setToken(token);

    try {
      await rest.put(Routes.applicationCommands(clientId), {
        body: this.getCommands(),
      });
      console.log("Successfully registered application commands.");
    } catch (error) {
      console.error(error);
    }
  }

  async handleInteraction(interaction: any): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.user.id !== this.allowedUserId) {
      await interaction.reply({
        content: "You are not authorized to use this bot.",
        ephemeral: true,
      });
      return;
    }

    const channelId = interaction.channelId;
    const commandName = interaction.commandName;

    try {
      switch (commandName) {
        case "clear":
          this.claudeManager.clearSession(channelId);
          await interaction.reply("Session cleared! Next message will start a new Claude Code session.");
          break;

        case "status":
          await this.handleStatusCommand(interaction, channelId);
          break;

        case "pause":
          await this.handlePauseCommand(interaction, channelId);
          break;

        case "resume":
          await this.handleResumeCommand(interaction, channelId);
          break;

        case "abort":
          await this.handleAbortCommand(interaction, channelId);
          break;

        default:
          await interaction.reply({
            content: "Unknown command.",
            ephemeral: true,
          });
      }
    } catch (error) {
      console.error(`Error handling command ${commandName}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await interaction.reply({
        content: `Error: ${errorMessage}`,
        ephemeral: true,
      });
    }
  }

  private async handleStatusCommand(interaction: any, channelId: string): Promise<void> {
    const state = this.claudeManager.getSessionState(channelId);
    const metadata = this.claudeManager.getSessionMetadata(channelId);

    let statusEmbed = new EmbedBuilder()
      .setTitle("📊 Session Status")
      .setTimestamp();

    if (!metadata) {
      statusEmbed
        .setDescription("No active session in this channel")
        .setColor(0x808080); // Gray
    } else {
      let color = 0x808080; // Default gray
      let stateEmoji = "⚪";

      switch (state) {
        case SessionState.ACTIVE:
          color = 0x00FF00; // Green
          stateEmoji = "🟢";
          break;
        case SessionState.PAUSED:
          color = 0xFF8C00; // Orange
          stateEmoji = "🟡";
          break;
        case SessionState.STARTING:
          color = 0xFFD700; // Yellow
          stateEmoji = "🟡";
          break;
        case SessionState.COMPLETED:
          color = 0x00FF00; // Green
          stateEmoji = "✅";
          break;
        case SessionState.ERROR:
        case SessionState.ABORTED:
          color = 0xFF0000; // Red
          stateEmoji = "🔴";
          break;
      }

      const locationText = metadata.isThread 
        ? `📌 Thread: ${metadata.threadName}\n📁 Project: ${metadata.channelName}`
        : `📁 Channel: ${metadata.channelName}`;

      statusEmbed
        .setColor(color)
        .setDescription([
          locationText,
          `**Session ID:** ${metadata.sessionId}`,
          `**State:** ${stateEmoji} ${state}`,
          `**Messages:** ${metadata.messageCount}`,
          `**Created:** <t:${Math.floor(metadata.createdAt / 1000)}:R>`,
          `**Last Active:** <t:${Math.floor(metadata.lastActiveAt / 1000)}:R>`,
        ].join('\n'));
    }

    await interaction.reply({ embeds: [statusEmbed] });
  }

  private async handlePauseCommand(interaction: any, channelId: string): Promise<void> {
    const state = this.claudeManager.getSessionState(channelId);

    if (state !== SessionState.ACTIVE) {
      await interaction.reply({
        content: "No active session to pause in this channel.",
        ephemeral: true,
      });
      return;
    }

    const success = this.claudeManager.pauseSession(channelId);
    if (success) {
      await interaction.reply("⏸️ Session paused. Use `/resume` to continue.");
    } else {
      await interaction.reply({
        content: "Failed to pause session.",
        ephemeral: true,
      });
    }
  }

  private async handleResumeCommand(interaction: any, channelId: string): Promise<void> {
    const state = this.claudeManager.getSessionState(channelId);

    if (state !== SessionState.PAUSED) {
      await interaction.reply({
        content: "No paused session to resume in this channel.",
        ephemeral: true,
      });
      return;
    }

    const success = this.claudeManager.resumeSession(channelId);
    if (success) {
      await interaction.reply("▶️ Session resumed.");
    } else {
      await interaction.reply({
        content: "Failed to resume session.",
        ephemeral: true,
      });
    }
  }

  private async handleAbortCommand(interaction: any, channelId: string): Promise<void> {
    const state = this.claudeManager.getSessionState(channelId);

    if (state !== SessionState.ACTIVE && state !== SessionState.PAUSED) {
      await interaction.reply({
        content: "No active session to abort in this channel.",
        ephemeral: true,
      });
      return;
    }

    const success = this.claudeManager.abortSession(channelId);
    if (success) {
      await interaction.reply("🛑 Session aborted.");
    } else {
      await interaction.reply({
        content: "Failed to abort session.",
        ephemeral: true,
      });
    }
  }
}