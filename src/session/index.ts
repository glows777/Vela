import type { ModelMessage } from "ai";
import { join } from 'node:path';
import { silentLogger, type VelaLogger } from '../logger';
import {
  fileSessionStorage,
  type SessionCheckpoint,
  type SessionStorage,
} from './storage';
import { ToolResultStore } from './tool-results';

export interface SessionState {
  messages: ModelMessage[];
  timestamps: Map<ModelMessage, number>;
  summary: string;
}

const SESSION_DIR = "sessions";

/**
 * 一个会话的保存和恢复：消息历史交给 SessionStorage（文件 / 内存 / 自定义），
 * 工具长输出和工具调用历史总是写在 `<dir>/<id>/` 下（模型要用 read_file 读它们）。
 */
export class SessionStore {
  readonly results: ToolResultStore;
  private readonly storage: SessionStorage;

  constructor(
    private readonly sessionId: string,
    dir: string = SESSION_DIR,
    logger: VelaLogger = silentLogger,
    storage?: SessionStorage,
  ) {
    this.storage = storage ?? fileSessionStorage(dir, logger);
    this.results = new ToolResultStore(join(dir, sessionId, 'tool-results'));
  }

  async replace(
    messages: ModelMessage[],
    timestamps: Map<ModelMessage, number>,
    summary: string,
    historyViewSequence = this.results.historyViewSequence,
  ): Promise<void> {
    const checkpoint: SessionCheckpoint = {
      type: "checkpoint",
      timestamp: new Date().toISOString(),
      summary,
      toolHistoryId: this.results.historyId,
      toolHistorySeq: this.results.history.throughSequence,
      toolHistoryViewSeq: historyViewSequence,
      messages: messages.map(message => ({
        timestamp: new Date(timestamps.get(message) ?? Date.now()).toISOString(),
        message,
      })),
    };
    await this.storage.save(this.sessionId, checkpoint);
  }

  /** 读保存的会话；没有时返回空状态。 */
  async loadState(): Promise<SessionState> {
    return (await this.loadSaved()) ?? { messages: [], timestamps: new Map(), summary: "" };
  }

  /** 读保存的会话；没有保存过返回 undefined。 */
  async loadSaved(): Promise<SessionState | undefined> {
    const checkpoint = await this.storage.load(this.sessionId);
    if (!checkpoint) return;
    const parseTimestamp = (value: string): number => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : Date.now();
    };
    const messages: ModelMessage[] = [];
    const timestamps = new Map<ModelMessage, number>();
    for (const stored of checkpoint.messages) {
      messages.push(stored.message);
      timestamps.set(stored.message, parseTimestamp(stored.timestamp));
    }
    if (checkpoint.toolHistoryId)
      await this.results.resumeHistory(
        checkpoint.toolHistoryId,
        checkpoint.toolHistorySeq ?? 0,
        checkpoint.toolHistoryViewSeq,
      );
    return { messages, timestamps, summary: checkpoint.summary || "" };
  }

  async load(): Promise<ModelMessage[]> {
    return (await this.loadState()).messages;
  }

  async exists(): Promise<boolean> {
    return (await this.storage.load(this.sessionId)) !== undefined;
  }
}
