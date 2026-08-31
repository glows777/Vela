import type { ModelMessage } from "ai";

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
}

export interface SessionState {
  messages: ModelMessage[];
  timestamps: Map<ModelMessage, number>;
  summary: string;
}

const SESSION_DIR = ".sessions";

export class SessionStore {
  private dir: string;
  private sessionId: string;

  private get filePath(): string {
    return `${this.dir}/${this.sessionId}.jsonl`;
  }

  constructor(sessionId: string, dir: string = SESSION_DIR) {
    this.sessionId = sessionId;
    this.dir = dir;
  }

  async replace(
    messages: ModelMessage[],
    timestamps: Map<ModelMessage, number>,
    summary: string,
  ): Promise<void> {
    await Bun.$`mkdir -p ${this.dir}`;

    const entry: CheckpointEntry = {
      type: "checkpoint",
      timestamp: new Date().toISOString(),
      summary,
      messages: messages.map(message => ({
        timestamp: new Date(timestamps.get(message) ?? Date.now()).toISOString(),
        message,
      })),
    };

    await Bun.write(this.filePath, JSON.stringify(entry) + "\n");
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
          for (const storedMessage of entry.messages) {
            messages.push(storedMessage.message);
            timestamps.set(
              storedMessage.message,
              parseTimestamp(storedMessage.timestamp),
            );
          }
        }
      } catch (error) {
        console.error(`[session store]: read line error: ${error}`);
      }
    }

    return { messages, timestamps, summary };
  }

  async load(): Promise<ModelMessage[]> {
    return (await this.loadState()).messages;
  }

  exists() {
    return Bun.file(this.filePath).exists();
  }
}
