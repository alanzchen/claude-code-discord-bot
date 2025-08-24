import { SessionState, SessionConfig, SessionMetadata, ChannelProcess } from '../types/index.js';
import { DatabaseManager } from '../db/database.js';
import { EventEmitter } from 'events';

export class SessionManager extends EventEmitter {
  private activeSessions = new Map<string, ChannelProcess>();
  private sessionMetadata = new Map<string, SessionMetadata>();
  private messageQueues = new Map<string, string[]>();

  constructor(private db: DatabaseManager) {
    super();
    this.setupCleanupTimers();
  }

  /**
   * Get session state for a channel
   */
  getSessionState(channelId: string): SessionState {
    const metadata = this.sessionMetadata.get(channelId);
    if (metadata) {
      return metadata.state;
    }

    // Check database for persisted state
    const dbSession = this.db.getSessionMetadata(channelId);
    if (dbSession?.state) {
      return dbSession.state as SessionState;
    }

    return SessionState.INACTIVE;
  }

  /**
   * Get session metadata for a channel
   */
  getSessionMetadata(channelId: string): SessionMetadata | undefined {
    return this.sessionMetadata.get(channelId);
  }

  /**
   * Create a new session with metadata
   */
  createSession(
    channelId: string,
    sessionId: string,
    channelName: string,
    config: SessionConfig = {},
    isThread: boolean = false,
    threadName?: string
  ): SessionMetadata {
    const metadata: SessionMetadata = {
      sessionId,
      channelId,
      channelName,
      state: SessionState.STARTING,
      config,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      messageCount: 0,
      isThread,
      threadName
    };

    this.sessionMetadata.set(channelId, metadata);
    this.messageQueues.set(channelId, []);

    // Persist to database
    this.db.setSessionWithMetadata(
      channelId,
      sessionId,
      channelName,
      SessionState.STARTING,
      config,
      isThread,
      threadName
    );

    this.emit('sessionCreated', metadata);
    return metadata;
  }

  /**
   * Update session state
   */
  updateSessionState(channelId: string, state: SessionState): void {
    const metadata = this.sessionMetadata.get(channelId);
    if (metadata) {
      metadata.state = state;
      metadata.lastActiveAt = Date.now();
      this.sessionMetadata.set(channelId, metadata);
    }

    // Update database
    this.db.updateSessionState(channelId, state);

    this.emit('sessionStateChanged', channelId, state);
  }

  /**
   * Set active process for a session
   */
  setActiveProcess(channelId: string, process: ChannelProcess): void {
    const metadata = this.sessionMetadata.get(channelId);
    if (metadata) {
      process.metadata = metadata;
    }

    this.activeSessions.set(channelId, process);
    this.updateSessionState(channelId, SessionState.ACTIVE);
  }

  /**
   * Get active process for a session
   */
  getActiveProcess(channelId: string): ChannelProcess | undefined {
    return this.activeSessions.get(channelId);
  }

  /**
   * Check if session has an active process
   */
  hasActiveProcess(channelId: string): boolean {
    return this.activeSessions.has(channelId);
  }

  /**
   * Add message to session queue
   */
  queueMessage(channelId: string, message: string): void {
    let queue = this.messageQueues.get(channelId);
    if (!queue) {
      queue = [];
      this.messageQueues.set(channelId, queue);
    }
    queue.push(message);

    // Increment message count
    this.incrementMessageCount(channelId);
  }

  /**
   * Get next message from queue
   */
  dequeueMessage(channelId: string): string | undefined {
    const queue = this.messageQueues.get(channelId);
    return queue?.shift();
  }

  /**
   * Check if session can accept new messages (is in ready state)
   */
  canAcceptMessages(channelId: string): boolean {
    const state = this.getSessionState(channelId);
    return state === SessionState.READY || state === SessionState.INACTIVE;
  }

  /**
   * Check if session has queued messages
   */
  hasQueuedMessages(channelId: string): boolean {
    const queue = this.messageQueues.get(channelId);
    return queue ? queue.length > 0 : false;
  }

  /**
   * Pause an active session
   */
  pauseSession(channelId: string): boolean {
    const process = this.activeSessions.get(channelId);
    if (process && process.process) {
      // Send SIGSTOP to pause the process
      try {
        process.process.kill('SIGSTOP');
        this.updateSessionState(channelId, SessionState.PAUSED);
        this.emit('sessionPaused', channelId);
        return true;
      } catch (error) {
        console.error(`Failed to pause session ${channelId}:`, error);
        return false;
      }
    }
    return false;
  }

  /**
   * Resume a paused session
   */
  resumeSession(channelId: string): boolean {
    const process = this.activeSessions.get(channelId);
    if (process && process.process) {
      try {
        process.process.kill('SIGCONT');
        this.updateSessionState(channelId, SessionState.ACTIVE);
        this.emit('sessionResumed', channelId);
        return true;
      } catch (error) {
        console.error(`Failed to resume session ${channelId}:`, error);
        return false;
      }
    }
    return false;
  }

  /**
   * Abort/terminate a session
   */
  abortSession(channelId: string): boolean {
    const process = this.activeSessions.get(channelId);
    if (process && process.process) {
      try {
        process.process.kill('SIGTERM');
        this.activeSessions.delete(channelId);
        this.updateSessionState(channelId, SessionState.ABORTED);
        this.emit('sessionAborted', channelId);
        return true;
      } catch (error) {
        console.error(`Failed to abort session ${channelId}:`, error);
        return false;
      }
    }
    return false;
  }

  /**
   * Complete a session (natural completion) - mark as ready for more messages
   */
  completeSession(channelId: string): void {
    this.activeSessions.delete(channelId);
    this.updateSessionState(channelId, SessionState.READY);
    this.emit('sessionCompleted', channelId);
  }

  /**
   * Fully complete a session (no more messages expected)
   */
  finalizeSession(channelId: string): void {
    this.activeSessions.delete(channelId);
    this.updateSessionState(channelId, SessionState.COMPLETED);
    this.emit('sessionFinalized', channelId);
  }

  /**
   * Handle session error
   */
  errorSession(channelId: string, error: Error): void {
    this.activeSessions.delete(channelId);
    this.updateSessionState(channelId, SessionState.ERROR);
    this.emit('sessionError', channelId, error);
  }

  /**
   * Clear session completely
   */
  clearSession(channelId: string): void {
    // Abort if active
    const process = this.activeSessions.get(channelId);
    if (process && process.process) {
      try {
        process.process.kill('SIGTERM');
      } catch (error) {
        console.error(`Error killing process for ${channelId}:`, error);
      }
    }

    // Clear all data
    this.activeSessions.delete(channelId);
    this.sessionMetadata.delete(channelId);
    this.messageQueues.delete(channelId);

    // Clear from database
    this.db.clearSession(channelId);

    this.emit('sessionCleared', channelId);
  }

  /**
   * Increment message count for a session
   */
  private incrementMessageCount(channelId: string): void {
    const metadata = this.sessionMetadata.get(channelId);
    if (metadata) {
      metadata.messageCount++;
      metadata.lastActiveAt = Date.now();
    }

    // Update database
    this.db.incrementMessageCount(channelId);
  }

  /**
   * Setup cleanup timers for inactive sessions
   */
  private setupCleanupTimers(): void {
    // Clean up completed/error sessions after 1 hour
    setInterval(() => {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      for (const [channelId, metadata] of this.sessionMetadata.entries()) {
        if (
          (metadata.state === SessionState.COMPLETED || 
           metadata.state === SessionState.ERROR ||
           metadata.state === SessionState.ABORTED) &&
          now - metadata.lastActiveAt > oneHour
        ) {
          console.log(`Cleaning up old session ${channelId} (${metadata.state})`);
          this.sessionMetadata.delete(channelId);
          this.messageQueues.delete(channelId);
        }
      }
    }, 15 * 60 * 1000); // Check every 15 minutes
  }

  /**
   * Get all sessions with their states
   */
  getAllSessions(): Map<string, SessionMetadata> {
    return new Map(this.sessionMetadata);
  }

  /**
   * Get sessions by state
   */
  getSessionsByState(state: SessionState): SessionMetadata[] {
    return Array.from(this.sessionMetadata.values()).filter(
      metadata => metadata.state === state
    );
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    // Terminate all active processes
    for (const [channelId, process] of this.activeSessions.entries()) {
      if (process.process) {
        try {
          process.process.kill('SIGTERM');
        } catch (error) {
          console.error(`Error terminating process for ${channelId}:`, error);
        }
      }
    }

    this.activeSessions.clear();
    this.sessionMetadata.clear();
    this.messageQueues.clear();
    this.removeAllListeners();
  }
}