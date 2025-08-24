import { Database } from "bun:sqlite";
import * as path from "path";

export interface ChannelSession {
  channelId: string;
  sessionId: string;
  channelName: string;
  lastUsed: number;
  state?: string;
  config?: string; // JSON string
  createdAt?: number;
  messageCount?: number;
  isThread?: boolean;
  threadName?: string;
}

export class DatabaseManager {
  private db: Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.join(process.cwd(), "sessions.db");
    this.db = new Database(finalPath);
    this.initializeTables();
  }

  private initializeTables(): void {
    // Create sessions table with enhanced schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_sessions (
        channel_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        last_used INTEGER NOT NULL,
        state TEXT DEFAULT 'inactive',
        config TEXT DEFAULT '{}',
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        message_count INTEGER DEFAULT 0,
        is_thread BOOLEAN DEFAULT 0,
        thread_name TEXT
      )
    `);

    // Add migration for existing sessions
    try {
      this.db.exec(`
        ALTER TABLE channel_sessions ADD COLUMN state TEXT DEFAULT 'inactive';
      `);
    } catch (e) {
      // Column already exists
    }
    
    try {
      this.db.exec(`
        ALTER TABLE channel_sessions ADD COLUMN config TEXT DEFAULT '{}';
      `);
    } catch (e) {
      // Column already exists
    }
    
    try {
      this.db.exec(`
        ALTER TABLE channel_sessions ADD COLUMN created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000);
      `);
    } catch (e) {
      // Column already exists
    }
    
    try {
      this.db.exec(`
        ALTER TABLE channel_sessions ADD COLUMN message_count INTEGER DEFAULT 0;
      `);
    } catch (e) {
      // Column already exists
    }
    
    try {
      this.db.exec(`
        ALTER TABLE channel_sessions ADD COLUMN is_thread BOOLEAN DEFAULT 0;
      `);
    } catch (e) {
      // Column already exists
    }
    
    try {
      this.db.exec(`
        ALTER TABLE channel_sessions ADD COLUMN thread_name TEXT;
      `);
    } catch (e) {
      // Column already exists
    }
  }

  getSession(channelId: string): string | undefined {
    const stmt = this.db.query("SELECT session_id FROM channel_sessions WHERE channel_id = ?");
    const result = stmt.get(channelId) as { session_id: string } | null;
    return result?.session_id;
  }

  getSessionMetadata(channelId: string): ChannelSession | undefined {
    const stmt = this.db.query(`
      SELECT channel_id, session_id, channel_name, last_used, state, config, 
             created_at, message_count, is_thread, thread_name 
      FROM channel_sessions WHERE channel_id = ?
    `);
    const result = stmt.get(channelId) as any;
    if (!result) return undefined;
    
    return {
      channelId: result.channel_id,
      sessionId: result.session_id,
      channelName: result.channel_name,
      lastUsed: result.last_used,
      state: result.state,
      config: result.config,
      createdAt: result.created_at,
      messageCount: result.message_count,
      isThread: !!result.is_thread,
      threadName: result.thread_name
    };
  }

  setSession(channelId: string, sessionId: string, channelName: string): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO channel_sessions (channel_id, session_id, channel_name, last_used)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(channelId, sessionId, channelName, Date.now());
  }

  setSessionWithMetadata(
    channelId: string, 
    sessionId: string, 
    channelName: string,
    state: string = 'inactive',
    config: object = {},
    isThread: boolean = false,
    threadName?: string
  ): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO channel_sessions 
      (channel_id, session_id, channel_name, last_used, state, config, created_at, message_count, is_thread, thread_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    stmt.run(
      channelId, 
      sessionId, 
      channelName, 
      Date.now(), 
      state,
      JSON.stringify(config),
      Date.now(),
      isThread ? 1 : 0,
      threadName || null
    );
  }

  updateSessionState(channelId: string, state: string): void {
    const stmt = this.db.query(`
      UPDATE channel_sessions 
      SET state = ?, last_used = ? 
      WHERE channel_id = ?
    `);
    stmt.run(state, Date.now(), channelId);
  }

  incrementMessageCount(channelId: string): void {
    const stmt = this.db.query(`
      UPDATE channel_sessions 
      SET message_count = message_count + 1, last_used = ? 
      WHERE channel_id = ?
    `);
    stmt.run(Date.now(), channelId);
  }

  updateSessionConfig(channelId: string, config: object): void {
    const stmt = this.db.query(`
      UPDATE channel_sessions 
      SET config = ?, last_used = ? 
      WHERE channel_id = ?
    `);
    stmt.run(JSON.stringify(config), Date.now(), channelId);
  }

  clearSession(channelId: string): void {
    const stmt = this.db.query("DELETE FROM channel_sessions WHERE channel_id = ?");
    stmt.run(channelId);
  }

  getAllSessions(): ChannelSession[] {
    const stmt = this.db.query("SELECT * FROM channel_sessions ORDER BY last_used DESC");
    return stmt.all() as ChannelSession[];
  }

  // Clean up old sessions (older than 30 days)
  cleanupOldSessions(): void {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const stmt = this.db.query("DELETE FROM channel_sessions WHERE last_used < ?");
    const result = stmt.run(thirtyDaysAgo);
    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} old sessions`);
    }
  }

  close(): void {
    this.db.close();
  }
}