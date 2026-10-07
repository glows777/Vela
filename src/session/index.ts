import type { ModelMessage } from "ai";
import { join } from 'node:path';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { silentLogger, type VelaLogger } from '../logger';
import { ToolResultStore } from './tool-results';

export interface MessageEntry {
  type: "message";
  timestamp: string;
  message: ModelMessage;
}

interface StoredMessage {
  timestamp: string;
  message: ModelMessage;
}

interface CheckpointEntry {
  type: "checkpoint";
  timestamp: string;
  summary: string;
  messages: StoredMessage[];
  toolHistoryId?: string;
  toolHistorySeq?: number;
  toolHistoryViewSeq?: number;
}

export interface SessionState {
  messages: ModelMessage[];
  timestamps: Map<ModelMessage, number>;
  summary: string;
}

const SESSION_DIR = ".sessions";

export class SessionStore {
  readonly results: ToolResultStore;
  private dir: string;
  private sessionId: string;

  private get filePath(): string {
    return `${this.dir}/${this.sessionId}.jsonl`;
  }

  constructor(
    sessionId: string,
    dir: string = SESSION_DIR,
    private logger: VelaLogger = silentLogger,
  ) {
    this.sessionId = sessionId;
    this.dir = dir;
    this.results = new ToolResultStore(join(dir, sessionId, 'tool-results'));
  }

  async replace(
    messages: ModelMessage[],
    timestamps: Map<ModelMessage, number>,
    summary: string,
    historyViewSequence = this.results.historyViewSequence,
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });

    const entry: CheckpointEntry = {
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

    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(entry) + '\n'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async loadState(): Promise<SessionState> {
    const file = Bun.file(this.filePath);

    if (!(await file.exists())) {
      return { messages: [], timestamps: new Map(), summary: "" };
    }

    const content = (await file.text()).trim();
    if (!content) {
      return { messages: [], timestamps: new Map(), summary: "" };
    }

    let messages: ModelMessage[] = [];
    let timestamps = new Map<ModelMessage, number>();
    let summary = "";
    let historyId: string | undefined;
    let historySequence = 0;
    let historyViewSequence: number | undefined;

    const parseTimestamp = (value: string): number => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : Date.now();
    };

    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as MessageEntry | CheckpointEntry;
        if (entry.type === "message") {
          messages.push(entry.message);
          timestamps.set(entry.message, parseTimestamp(entry.timestamp));
        } else if (
          entry.type === "checkpoint" &&
          Array.isArray(entry.messages)
        ) {
          messages = [];
          timestamps = new Map();
          summary = entry.summary || "";
          historyId = entry.toolHistoryId;
          historySequence = entry.toolHistorySeq ?? 0;
          historyViewSequence = entry.toolHistoryViewSeq;
          for (const storedMessage of entry.messages) {
            messages.push(storedMessage.message);
            timestamps.set(
              storedMessage.message,
              parseTimestamp(storedMessage.timestamp),
            );
          }
        }
      } catch (error) {
        this.logger.warn(`[session] ${this.filePath} 有一行无法解析，已跳过: ${error}`);
      }
    }

    if (historyId) await this.results.resumeHistory(historyId, historySequence, historyViewSequence);
    return { messages, timestamps, summary };
  }

  async load(): Promise<ModelMessage[]> {
    return (await this.loadState()).messages;
  }

  exists() {
    return Bun.file(this.filePath).exists();
  }
}
