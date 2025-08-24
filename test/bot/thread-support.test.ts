import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordBot } from "../../src/bot/client.js";

// Mock Discord Client
vi.mock("discord.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    once: vi.fn(),
    on: vi.fn(),
    login: vi.fn(),
    user: { tag: "TestBot#1234", id: "test-bot-id" },
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    GuildMessageReactions: 8,
  },
  EmbedBuilder: vi.fn().mockImplementation(() => ({
    setTitle: vi.fn().mockReturnThis(),
    setDescription: vi.fn().mockReturnThis(),
    setColor: vi.fn().mockReturnThis(),
  })),
  ChannelType: {
    GuildText: 0,
    PublicThread: 11,
    PrivateThread: 12,
    AnnouncementThread: 10,
  },
  MessageType: {
    Default: 0,
    ThreadCreated: 18,
    ThreadStarterMessage: 21,
  },
}));

// Mock ClaudeManager
const mockClaudeManager = {
  hasActiveProcess: vi.fn(),
  getSessionId: vi.fn(),
  setDiscordMessage: vi.fn(),
  reserveChannel: vi.fn(),
  runClaudeCode: vi.fn(),
  clearSession: vi.fn(),
};

// Mock CommandHandler
vi.mock("../../src/bot/commands.js", () => ({
  CommandHandler: vi.fn().mockImplementation(() => ({
    registerCommands: vi.fn(),
    handleInteraction: vi.fn(),
  })),
}));

describe("DiscordBot Thread Support", () => {
  let bot: DiscordBot;
  const allowedUserId = "test-user-123";
  
  // Get ChannelType and MessageType from our mock
  const ChannelType = {
    GuildText: 0,
    PublicThread: 11,
    PrivateThread: 12,
    AnnouncementThread: 10,
  };

  const MessageType = {
    Default: 0,
    ThreadCreated: 18,
    ThreadStarterMessage: 21,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    bot = new DiscordBot(mockClaudeManager as any, allowedUserId);
  });

  describe("handleMessage with threads", () => {
    it("should handle regular channel messages", async () => {
      const mockMessage = {
        author: { bot: false, id: allowedUserId },
        channelId: "channel-123",
        content: "test message",
        id: "msg-123",
        type: MessageType.Default,
        channel: {
          type: ChannelType.GuildText,
          name: "test-project",
          send: vi.fn().mockResolvedValue({ id: "reply-123" }),
        },
      };

      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getSessionId.mockReturnValue(undefined);

      // Access private method for testing
      await (bot as any).handleMessage(mockMessage);

      expect(mockClaudeManager.reserveChannel).toHaveBeenCalledWith(
        "channel-123",
        undefined,
        expect.any(Object)
      );
      expect(mockClaudeManager.runClaudeCode).toHaveBeenCalledWith(
        "channel-123",
        "test-project",
        "test message",
        undefined,
        expect.objectContaining({
          channelId: "channel-123",
          channelName: "test-project",
          userId: allowedUserId,
          messageId: "msg-123",
          isThread: false,
          threadName: undefined,
        })
      );
    });

    it("should handle public thread messages", async () => {
      const mockMessage = {
        author: { bot: false, id: allowedUserId },
        channelId: "thread-456", // This is the thread ID
        content: "test thread message",
        id: "msg-456",
        type: MessageType.Default,
        channel: {
          type: ChannelType.PublicThread,
          name: "my-discussion",
          parent: {
            name: "test-project", // Parent channel name for folder mapping
          },
          send: vi.fn().mockResolvedValue({ id: "reply-456" }),
        },
      };

      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getSessionId.mockReturnValue(undefined);

      await (bot as any).handleMessage(mockMessage);

      expect(mockClaudeManager.reserveChannel).toHaveBeenCalledWith(
        "thread-456", // Thread ID used for session management
        undefined,
        expect.any(Object)
      );
      expect(mockClaudeManager.runClaudeCode).toHaveBeenCalledWith(
        "thread-456", // Thread ID
        "test-project", // Parent channel name for folder mapping
        "test thread message",
        undefined,
        expect.objectContaining({
          channelId: "thread-456",
          channelName: "test-project", // Parent channel for folder
          userId: allowedUserId,
          messageId: "msg-456",
          isThread: true,
          threadName: "my-discussion", // Thread name
        })
      );
    });

    it("should handle private thread messages", async () => {
      const mockMessage = {
        author: { bot: false, id: allowedUserId },
        channelId: "private-thread-789",
        content: "private thread message",
        id: "msg-789",
        type: MessageType.Default,
        channel: {
          type: ChannelType.PrivateThread,
          name: "private-discussion",
          parent: {
            name: "secret-project",
          },
          send: vi.fn().mockResolvedValue({ id: "reply-789" }),
        },
      };

      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getSessionId.mockReturnValue("existing-session");

      await (bot as any).handleMessage(mockMessage);

      expect(mockClaudeManager.runClaudeCode).toHaveBeenCalledWith(
        "private-thread-789",
        "secret-project",
        "private thread message",
        "existing-session",
        expect.objectContaining({
          channelId: "private-thread-789",
          channelName: "secret-project",
          isThread: true,
          threadName: "private-discussion",
        })
      );
    });

    it("should handle announcement thread messages", async () => {
      const mockMessage = {
        author: { bot: false, id: allowedUserId },
        channelId: "announcement-thread-101",
        content: "announcement thread message",
        id: "msg-101",
        type: MessageType.Default,
        channel: {
          type: ChannelType.AnnouncementThread,
          name: "important-updates",
          parent: {
            name: "main-project",
          },
          send: vi.fn().mockResolvedValue({ id: "reply-101" }),
        },
      };

      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getSessionId.mockReturnValue(undefined);

      await (bot as any).handleMessage(mockMessage);

      expect(mockClaudeManager.runClaudeCode).toHaveBeenCalledWith(
        "announcement-thread-101",
        "main-project",
        "announcement thread message",
        undefined,
        expect.objectContaining({
          channelId: "announcement-thread-101",
          channelName: "main-project",
          isThread: true,
          threadName: "important-updates",
        })
      );
    });

    it("should skip threads in general channel", async () => {
      const mockMessage = {
        author: { bot: false, id: allowedUserId },
        channelId: "general-thread-123",
        content: "should be ignored",
        id: "msg-general",
        type: MessageType.Default,
        channel: {
          type: ChannelType.PublicThread,
          name: "some-thread",
          parent: {
            name: "general", // Parent is general channel
          },
        },
      };

      mockClaudeManager.hasActiveProcess.mockReturnValue(false);

      await (bot as any).handleMessage(mockMessage);

      expect(mockClaudeManager.reserveChannel).not.toHaveBeenCalled();
      expect(mockClaudeManager.runClaudeCode).not.toHaveBeenCalled();
    });

    it("should handle threads with missing parent gracefully", async () => {
      const mockMessage = {
        author: { bot: false, id: allowedUserId },
        channelId: "orphan-thread-123",
        content: "orphan thread message",
        id: "msg-orphan",
        type: MessageType.Default,
        channel: {
          type: ChannelType.PublicThread,
          name: "orphan-thread",
          parent: null, // No parent
          send: vi.fn().mockResolvedValue({ id: "reply-orphan" }),
        },
      };

      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getSessionId.mockReturnValue(undefined);

      await (bot as any).handleMessage(mockMessage);

      expect(mockClaudeManager.runClaudeCode).toHaveBeenCalledWith(
        "orphan-thread-123",
        "default", // Falls back to default
        "orphan thread message",
        undefined,
        expect.objectContaining({
          channelName: "default",
          isThread: true,
          threadName: "orphan-thread",
        })
      );
    });

    it("should handle edge case where thread has parent property but type detection fails", async () => {
      const mockMessage = {
        author: { bot: false, id: allowedUserId },
        channelId: "edge-case-thread-456",
        content: "edge case thread message",
        id: "msg-edge",
        type: MessageType.Default,
        channel: {
          type: 999, // Unknown/invalid type that doesn't match thread types
          name: "edge-thread",
          parent: {
            name: "parent-project", // But has valid parent
          },
          send: vi.fn().mockResolvedValue({ id: "reply-edge" }),
        },
      };

      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getSessionId.mockReturnValue(undefined);

      await (bot as any).handleMessage(mockMessage);

      // Should still detect as thread due to parent property and use parent channel name
      expect(mockClaudeManager.runClaudeCode).toHaveBeenCalledWith(
        "edge-case-thread-456",
        "parent-project", // Should use parent channel name
        "edge case thread message",
        undefined,
        expect.objectContaining({
          channelName: "parent-project",
          isThread: true,
          threadName: "edge-thread",
        })
      );
    });

    it("should ignore thread creation system messages", async () => {
      const mockMessage = {
        author: { bot: false, id: allowedUserId },
        channelId: "thread-456",
        content: "", // Thread creation messages often have empty content
        id: "msg-thread-create",
        type: MessageType.ThreadCreated, // System message type
        channel: {
          type: ChannelType.PublicThread,
          name: "new-thread",
          parent: {
            name: "test-project",
          },
        },
      };

      mockClaudeManager.hasActiveProcess.mockReturnValue(false);

      await (bot as any).handleMessage(mockMessage);

      // Should not process thread creation messages
      expect(mockClaudeManager.reserveChannel).not.toHaveBeenCalled();
      expect(mockClaudeManager.runClaudeCode).not.toHaveBeenCalled();
    });

    it("should ignore thread starter system messages", async () => {
      const mockMessage = {
        author: { bot: false, id: allowedUserId },
        channelId: "thread-789",
        content: "Started a thread: Feature Discussion",
        id: "msg-thread-starter",
        type: MessageType.ThreadStarterMessage, // System message type
        channel: {
          type: ChannelType.PublicThread,
          name: "feature-discussion",
          parent: {
            name: "main-project",
          },
        },
      };

      mockClaudeManager.hasActiveProcess.mockReturnValue(false);

      await (bot as any).handleMessage(mockMessage);

      // Should not process thread starter messages
      expect(mockClaudeManager.reserveChannel).not.toHaveBeenCalled();
      expect(mockClaudeManager.runClaudeCode).not.toHaveBeenCalled();
    });
  });
});