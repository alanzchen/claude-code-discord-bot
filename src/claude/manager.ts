import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder } from "discord.js";
import { SDKMessage, SessionState, SessionConfig } from "../types/index.js";
import { buildClaudeCommand, type DiscordContext } from "../utils/shell.js";
import { DatabaseManager } from "../db/database.js";
import { SessionManager } from "./session-manager.js";

export class ClaudeManager {
  private db: DatabaseManager;
  private sessionManager: SessionManager;
  private channelMessages = new Map<string, any>();
  private channelToolCalls = new Map<string, Map<string, { message: any, toolId: string }>>();
  private channelNames = new Map<string, string>();

  constructor(private baseFolder: string) {
    this.db = new DatabaseManager();
    this.sessionManager = new SessionManager(this.db);
    
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();

    // Set up session manager event handlers
    this.setupSessionManagerEvents();
  }

  private setupSessionManagerEvents(): void {
    this.sessionManager.on('sessionStateChanged', (channelId: string, state: SessionState) => {
      console.log(`Session ${channelId} state changed to: ${state}`);
      this.updateDiscordStatus(channelId, state);
    });

    this.sessionManager.on('sessionCompleted', (channelId: string) => {
      console.log(`Session ${channelId} completed`);
    });

    this.sessionManager.on('sessionError', (channelId: string, error: Error) => {
      console.error(`Session ${channelId} error:`, error);
    });
  }

  private updateDiscordStatus(channelId: string, state: SessionState): void {
    const message = this.channelMessages.get(channelId);
    if (!message?.edit) return;

    const metadata = this.sessionManager.getSessionMetadata(channelId);
    if (!metadata) return;

    let statusEmbed = new EmbedBuilder();
    let color = 0xFFD700; // Default yellow

    switch (state) {
      case SessionState.STARTING:
        statusEmbed.setTitle("🚀 Starting Session");
        color = 0xFFD700; // Yellow
        break;
      case SessionState.ACTIVE:
        statusEmbed.setTitle("⚡ Session Active");
        color = 0x00FF00; // Green
        break;
      case SessionState.PAUSED:
        statusEmbed.setTitle("⏸️ Session Paused");
        color = 0xFF8C00; // Orange
        break;
      case SessionState.READY:
        statusEmbed.setTitle("✅ Task Complete");
        color = 0x00FF00; // Green
        break;
      case SessionState.COMPLETED:
        statusEmbed.setTitle("✅ Session Complete");
        color = 0x00FF00; // Green
        break;
      case SessionState.ERROR:
        statusEmbed.setTitle("❌ Session Error");
        color = 0xFF0000; // Red
        break;
      case SessionState.ABORTED:
        statusEmbed.setTitle("🛑 Session Aborted");
        color = 0xFF0000; // Red
        break;
    }

    const locationText = metadata.isThread 
      ? `📌 Thread: ${metadata.threadName}\n📁 Project: ${metadata.channelName}`
      : `📁 Channel: ${metadata.channelName}`;

    statusEmbed
      .setColor(color)
      .setDescription(`${locationText}\n**Session ID:** ${metadata.sessionId}\n**Messages:** ${metadata.messageCount}`)
      .setTimestamp();

    message.edit({ embeds: [statusEmbed] }).catch(console.error);
  }

  hasActiveProcess(channelId: string): boolean {
    return this.sessionManager.hasActiveProcess(channelId);
  }

  getSessionState(channelId: string): SessionState {
    return this.sessionManager.getSessionState(channelId);
  }

  getSessionMetadata(channelId: string) {
    return this.sessionManager.getSessionMetadata(channelId);
  }

  killActiveProcess(channelId: string): void {
    this.sessionManager.abortSession(channelId);
  }

  clearSession(channelId: string): void {
    this.sessionManager.clearSession(channelId);
    this.channelMessages.delete(channelId);
    this.channelToolCalls.delete(channelId);
    this.channelNames.delete(channelId);
  }

  pauseSession(channelId: string): boolean {
    return this.sessionManager.pauseSession(channelId);
  }

  resumeSession(channelId: string): boolean {
    return this.sessionManager.resumeSession(channelId);
  }

  abortSession(channelId: string): boolean {
    return this.sessionManager.abortSession(channelId);
  }

  /**
   * Send a follow-up message to an existing session by starting a new Claude process with --resume
   */
  async continueSession(channelId: string, message: string, discordContext?: DiscordContext): Promise<void> {
    const metadata = this.sessionManager.getSessionMetadata(channelId);
    if (!metadata || metadata.sessionId === 'pending') {
      throw new Error('No valid session to continue');
    }

    // Check if there's already an active process for this channel
    if (this.sessionManager.hasActiveProcess(channelId)) {
      throw new Error('Session already has an active process. Wait for it to complete or abort it first.');
    }

    console.log(`Continuing session ${metadata.sessionId} with new message`);

    // Use the existing runClaudeCode method but with the resume flag
    await this.runClaudeCode(
      channelId, 
      metadata.channelName, 
      message, 
      metadata.sessionId, // This will trigger --resume
      discordContext,
      metadata.config
    );
  }

  setDiscordMessage(channelId: string, message: any): void {
    this.channelMessages.set(channelId, message);
    this.channelToolCalls.set(channelId, new Map());
  }

  reserveChannel(
    channelId: string,
    sessionId: string | undefined,
    discordMessage: any,
    config: SessionConfig = {},
    isThread: boolean = false,
    threadName?: string
  ): void {
    // Abort any existing session
    if (this.sessionManager.hasActiveProcess(channelId)) {
      console.log(`Aborting existing session for channel ${channelId} before starting new one`);
      this.sessionManager.abortSession(channelId);
    }

    // Create or update session metadata
    const channelName = this.channelNames.get(channelId) || 'default';
    if (sessionId) {
      // Update existing session
      this.sessionManager.updateSessionState(channelId, SessionStateEnum.STARTING);
    } else {
      // Create new session - sessionId will be set when Claude responds
      this.sessionManager.createSession(
        channelId,
        'pending', // Temporary until Claude provides real sessionId
        channelName,
        config,
        isThread,
        threadName
      );
    }
  }

  getSessionId(channelId: string): string | undefined {
    // First check session manager for active sessions
    const metadata = this.sessionManager.getSessionMetadata(channelId);
    if (metadata && metadata.sessionId !== 'pending') {
      return metadata.sessionId;
    }
    
    // Fall back to database
    return this.db.getSession(channelId);
  }

  async runClaudeCode(
    channelId: string,
    channelName: string,
    prompt: string,
    sessionId?: string,
    discordContext?: DiscordContext,
    config: SessionConfig = {}
  ): Promise<void> {
    // Store the channel name for path replacement
    this.channelNames.set(channelId, channelName);
    const workingDir = path.join(this.baseFolder, channelName);
    console.log(`Running Claude Code in: ${workingDir}`);

    // Check if working directory exists
    if (!fs.existsSync(workingDir)) {
      this.sessionManager.errorSession(channelId, new Error(`Working directory does not exist: ${workingDir}`));
      throw new Error(`Working directory does not exist: ${workingDir}`);
    }

    const commandString = buildClaudeCommand(workingDir, prompt, sessionId, discordContext);
    console.log(`Running command: ${commandString}`);

    const claude = spawn("/bin/bash", ["-c", commandString], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SHELL: "/bin/bash",
      },
    });

    console.log(`Claude process spawned with PID: ${claude.pid}`);

    // Set the active process in session manager
    this.sessionManager.setActiveProcess(channelId, {
      process: claude,
      sessionId,
      discordMessage: this.channelMessages.get(channelId),
      messageQueue: [],
      inputStream: claude.stdin
    });

    // Add message to queue
    this.sessionManager.queueMessage(channelId, prompt);

    // Close stdin to signal we're not sending more input to this process
    claude.stdin.end();

    // Add immediate listeners to debug
    claude.on("spawn", () => {
      console.log("Process successfully spawned");
    });

    claude.on("error", (error) => {
      console.error("Process spawn error:", error);
      this.sessionManager.errorSession(channelId, error);
    });

    let buffer = "";

    // Set a timeout for the Claude process (5 minutes)
    const timeout = setTimeout(() => {
      console.log("Claude process timed out, killing it");
      claude.kill("SIGTERM");
      this.sessionManager.errorSession(channelId, new Error("Session timed out after 5 minutes"));

      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⏰ Timeout")
          .setDescription("Claude Code took too long to respond (5 minutes)")
          .setColor(0xFFD700); // Yellow for timeout
        
        channel.send({ embeds: [timeoutEmbed] }).catch(console.error);
      }
    }, 5 * 60 * 1000); // 5 minutes

    claude.stdout.on("data", (data) => {
      const rawData = data.toString();
      console.log("Raw stdout data:", rawData);
      
      // Log all streamed output to log.txt
      try {
        fs.appendFileSync(path.join(process.cwd(), 'log.txt'), 
          `[${new Date().toISOString()}] Channel: ${channelId}\n${rawData}\n---\n`);
      } catch (error) {
        console.error("Error writing to log.txt:", error);
      }
      
      buffer += rawData;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          console.log("Processing line:", line);
          try {
            const parsed: SDKMessage = JSON.parse(line);
            console.log("Parsed message type:", parsed.type);

            if (parsed.type === "assistant" && parsed.message.content) {
              this.handleAssistantMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "user" && parsed.message.content) {
              this.handleToolResultMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "result") {
              this.handleResultMessage(channelId, parsed).then(() => {
                clearTimeout(timeout);
                claude.kill("SIGTERM");
                // Session completion is handled in the close event handler
              }).catch(console.error);
            } else if (parsed.type === "system") {
              console.log("System message:", parsed.subtype);
              if (parsed.subtype === "init") {
                this.handleInitMessage(channelId, parsed).catch(console.error);
              }
              const channelName = this.channelNames.get(channelId) || "default";
              this.db.setSession(channelId, parsed.session_id, channelName);
            }
          } catch (error) {
            console.error("Error parsing JSON:", error, "Line:", line);
          }
        }
      }
    });

    claude.on("close", (code) => {
      console.log(`Claude process exited with code ${code}`);
      clearTimeout(timeout);

      if (code === 0 || code === null) {
        // Normal completion - mark session as completed but keep metadata for resumption
        this.sessionManager.completeSession(channelId);
        
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const completionEmbed = new EmbedBuilder()
            .setTitle("✅ Task Complete")
            .setDescription("Session ready for your next message")
            .setColor(0x00FF00); // Green
          
          channel.send({ embeds: [completionEmbed] }).catch(console.error);
        }
      } else {
        // Process failed
        this.sessionManager.errorSession(channelId, new Error(`Process exited with code: ${code}`));
        
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Claude Code Failed")
            .setDescription(`Process exited with code: ${code}`)
            .setColor(0xFF0000); // Red for error
          
          channel.send({ embeds: [errorEmbed] }).catch(console.error);
        }
      }
    });

    claude.stderr.on("data", (data) => {
      const stderrOutput = data.toString();
      console.error("Claude stderr:", stderrOutput);

      // If there's significant stderr output, send warning to Discord
      if (
        stderrOutput.trim() &&
        !stderrOutput.includes("INFO") &&
        !stderrOutput.includes("DEBUG")
      ) {
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const warningEmbed = new EmbedBuilder()
            .setTitle("⚠️ Warning")
            .setDescription(stderrOutput.trim())
            .setColor(0xFFA500); // Orange for warnings
          
          channel.send({ embeds: [warningEmbed] }).catch(console.error);
        }
      }
    });

    claude.on("error", (error) => {
      console.error("Claude process error:", error);
      clearTimeout(timeout);

      // Handle session error through session manager
      this.sessionManager.errorSession(channelId, error);

      // Send error to Discord
      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const processErrorEmbed = new EmbedBuilder()
          .setTitle("❌ Process Error")
          .setDescription(error.message)
          .setColor(0xFF0000); // Red for errors
        
        channel.send({ embeds: [processErrorEmbed] }).catch(console.error);
      }
    });
  }

  private async handleInitMessage(channelId: string, parsed: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;
    
    const initEmbed = new EmbedBuilder()
      .setTitle("🚀 Claude Code Session Started")
      .setDescription(`**Working Directory:** ${parsed.cwd}\n**Model:** ${parsed.model}\n**Tools:** ${parsed.tools.length} available`)
      .setColor(0x00FF00); // Green for init
    
    try {
      await channel.send({ embeds: [initEmbed] });
    } catch (error) {
      console.error("Error sending init message:", error);
    }
  }

  private async handleAssistantMessage(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" }
  ): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    // Check for tool use in the message
    const toolUses = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    try {
      // If there's text content, send an assistant message
      if (content && content.trim()) {
        const assistantEmbed = new EmbedBuilder()
          .setTitle("💬 Claude")
          .setDescription(content)
          .setColor(0x7289DA); // Discord blurple
        
        await channel.send({ embeds: [assistantEmbed] });
      }
      
      // If there are tool uses, send a message for each tool
      for (const tool of toolUses) {
        let toolMessage = `🔧 ${tool.name}`;

        if (tool.input && Object.keys(tool.input).length > 0) {
          const inputs = Object.entries(tool.input)
            .map(([key, value]) => {
              let val = String(value);
              // Replace base folder path with relative path
              const channelName = this.channelNames.get(channelId);
              if (channelName) {
                const basePath = `${this.baseFolder}${channelName}`;
                if (val === basePath) {
                  val = ".";
                } else if (val.startsWith(basePath + "/")) {
                  val = val.replace(basePath + "/", "./");
                }
              }
              return `${key}=${val}`;
            })
            .join(", ");
          toolMessage += ` (${inputs})`;
        }

        const toolEmbed = new EmbedBuilder()
          .setDescription(`⏳ ${toolMessage}`)
          .setColor(0x0099FF); // Blue for tool calls

        const sentMessage = await channel.send({ embeds: [toolEmbed] });
        
        // Track this tool call message for later updating
        toolCalls.set(tool.id, {
          message: sentMessage,
          toolId: tool.id
        });
      }

      const channelName = this.channelNames.get(channelId) || "default";
      this.db.setSession(channelId, parsed.session_id, channelName);
      this.channelToolCalls.set(channelId, toolCalls);
    } catch (error) {
      console.error("Error sending assistant message:", error);
    }
  }

  private async handleToolResultMessage(channelId: string, parsed: any): Promise<void> {
    const toolResults = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_result")
      : [];

    if (toolResults.length === 0) return;

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    for (const result of toolResults) {
      const toolCall = toolCalls.get(result.tool_use_id);
      if (toolCall && toolCall.message) {
        try {
          // Get the first line of the result
          const firstLine = result.content.split('\n')[0].trim();
          const resultText = firstLine.length > 100 
            ? firstLine.substring(0, 100) + "..."
            : firstLine;
          
          // Get the current embed and update it
          const currentEmbed = toolCall.message.embeds[0];
          const originalDescription = currentEmbed.data.description.replace("⏳", "✅");
          const isError = result.is_error === true;
          
          const updatedEmbed = new EmbedBuilder();
          
          if (isError) {
            updatedEmbed
              .setDescription(`❌ ${originalDescription.substring(2)}\n*${resultText}*`)
              .setColor(0xFF0000); // Red for errors
          } else {
            updatedEmbed
              .setDescription(`${originalDescription}\n*${resultText}*`)
              .setColor(0x00FF00); // Green for completed
          }

          await toolCall.message.edit({ embeds: [updatedEmbed] });
        } catch (error) {
          console.error("Error updating tool result message:", error);
        }
      }
    }
  }

  private async handleResultMessage(
    channelId: string,
    parsed: SDKMessage & { type: "result" }
  ): Promise<void> {
    console.log("Result message:", parsed);
    const channelName = this.channelNames.get(channelId) || "default";
    
    // Update session with actual session ID and persist to database
    const metadata = this.sessionManager.getSessionMetadata(channelId);
    if (metadata) {
      metadata.sessionId = parsed.session_id;
      this.db.setSession(channelId, parsed.session_id, channelName);
    }

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    // Create a final result embed
    const resultEmbed = new EmbedBuilder();

    if (parsed.subtype === "success") {
      let description = "result" in parsed ? parsed.result : "Task completed";
      description += `\n\n*Completed in ${parsed.num_turns} turns*`;
      
      resultEmbed
        .setTitle("✅ Session Complete")
        .setDescription(description)
        .setColor(0x00FF00); // Green for success
        
      // Mark session as completed
      this.sessionManager.completeSession(channelId);
    } else {
      resultEmbed
        .setTitle("❌ Session Failed")
        .setDescription(`Task failed: ${parsed.subtype}`)
        .setColor(0xFF0000); // Red for failure
        
      // Mark session as error
      this.sessionManager.errorSession(channelId, new Error(`Session failed: ${parsed.subtype}`));
    }

    try {
      await channel.send({ embeds: [resultEmbed] });
    } catch (error) {
      console.error("Error sending result message:", error);
    }

    console.log("Got result message, session state updated");
  }



  // Clean up resources
  destroy(): void {
    // Clean up session manager
    this.sessionManager.destroy();
    
    // Close database connection
    this.db.close();
  }
}
