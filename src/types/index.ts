export type SDKMessage =
  | {
      type: "assistant";
      message: any;
      session_id: string;
    }
  | {
      type: "user";
      message: any;
      session_id: string;
    }
  | {
      type: "result";
      subtype: "success";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
      total_cost_usd: number;
    }
  | {
      type: "result";
      subtype: "error_max_turns" | "error_during_execution";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      session_id: string;
      total_cost_usd: number;
    }
  | {
      type: "system";
      subtype: "init";
      apiKeySource: string;
      cwd: string;
      session_id: string;
      tools: string[];
      mcp_servers: {
        name: string;
        status: string;
      }[];
      model: string;
      permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
    };

// Session state enumeration
export enum SessionState {
  INACTIVE = 'inactive',
  STARTING = 'starting', 
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  ERROR = 'error',
  ABORTED = 'aborted'
}

// Enhanced session configuration
export interface SessionConfig {
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
}

// Enhanced session metadata
export interface SessionMetadata {
  sessionId: string;
  channelId: string;
  channelName: string;
  state: SessionState;
  config: SessionConfig;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  isThread: boolean;
  threadName?: string;
}

export interface ChannelProcess {
  process: any;
  sessionId?: string;
  discordMessage: any;
  metadata?: SessionMetadata;
  messageQueue?: string[];
  inputStream?: any;
}

export interface Config {
  discordToken: string;
  allowedUserId: string;
  baseFolder: string;
}