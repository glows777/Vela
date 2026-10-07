import type { ModelMessage } from "ai";
import { join } from 'node:path';
import { silentLogger, type VelaLogger } from '../logger.ts';
import {
  fileSessionStorage,
  SESSION_FORMAT_VERSION,
  type SessionCheckpoint,
  type SessionStorage,
} from './storage.ts';
import { ToolResultStore } from './tool-results.ts';

export interface SessionState {
  messages: ModelMessage[];
  timestamps: Map<ModelMessage, number>;
  summary: string;
}

/** checkpoint 里除了消息以外、会话自己要还原的设置。 */
export type SessionSettings = Pick<SessionCheckpoint, 'model' | 'thinkingLevel' | 'name'>;

const SESSION_DIR = "sessions";

/**
 * 一个会话的保存和恢复：消息历史交给 SessionStorage（文件 / 内存 / 自定义），
 * 工具长输出和工具调用历史总是写在 `<dir>/<id>/` 下（模型要用 read_file 读它们）。
 */
export class SessionStore {
  readonly results: ToolResultStore;
  private readonly storage: SessionStorage;
  /** 每次保存时写进 checkpoint 的会话设置（模型、thinking） */
  settings: () => SessionSettings = () => ({});

  constructor(
    private readonly sessionId: string,
    dir: string = SESSION_DIR,
    private readonly logger: VelaLogger = silentLogger,
    storage?: SessionStorage,
    /** 工具历史在临时目录里（自定义存储 + 没给 dataDir）：恢复时找不到就重新开始，不报错 */
    private readonly temporaryResults = false,
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
      version: SESSION_FORMAT_VERSION,
      timestamp: new Date().toISOString(),
      summary,
      toolHistoryId: this.results.historyId,
      toolHistorySeq: this.results.history.throughSequence,
      toolHistoryViewSeq: historyViewSequence,
      ...this.settings(),
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
  async loadSaved(): Promise<(SessionState & SessionSettings) | undefined> {
    const checkpoint = await this.storage.load(this.sessionId);
    if (!checkpoint) return;
    const version = checkpoint.version ?? 1;
    if (version > SESSION_FORMAT_VERSION)
      throw new Error(
        `会话 ${this.sessionId} 的文件格式版本是 ${version}，这个 Vela 只认识到 ${SESSION_FORMAT_VERSION}：请升级 Vela`,
      );
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
    if (checkpoint.toolHistoryId) {
      try {
        await this.results.resumeHistory(
          checkpoint.toolHistoryId,
          checkpoint.toolHistorySeq ?? 0,
          checkpoint.toolHistoryViewSeq,
        );
      } catch (error) {
        // 上一个 Vela 实例的临时目录已经删了：消息照常恢复，工具调用历史从头记
        if (!this.temporaryResults) throw error;
        this.logger.warn(
          `[session] ${this.sessionId} 的工具调用历史在上次的临时目录里，已不存在；要保留请传 dataDir`,
        );
      }
    }
    return {
      messages,
      timestamps,
      summary: checkpoint.summary || "",
      model: checkpoint.model,
      thinkingLevel: checkpoint.thinkingLevel,
      name: checkpoint.name,
    };
  }

  async load(): Promise<ModelMessage[]> {
    return (await this.loadState()).messages;
  }

  async exists(): Promise<boolean> {
    return (await this.storage.load(this.sessionId)) !== undefined;
  }
}
