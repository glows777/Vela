import type { ModelMessage } from "ai";

export interface MessageEntry {
  type: "message";
  timestamp: string;
  message: ModelMessage;
}

const SESSION_DIR = ".sessions";

export class SessionStore {
  private dir: string;
  private sessionId: string;

  private get filePath(): string {
    return `${this.dir}/${this.sessionId}.jsonl`;
  }

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.dir = SESSION_DIR;
  }

  async append(message: ModelMessage) {
    const entry: MessageEntry = {
      type: "message",
      timestamp: new Date().toISOString(),
      message,
    };

    const file = Bun.file(this.filePath);
    const current = (await file.exists()) ? await file.text() : "";

    await Bun.write(this.filePath, current + JSON.stringify(entry) + "\n");
  }

  async appendAll(messages: ModelMessage[]) {
    for (const message of messages) {
      await this.append(message);
    }
  }

  async load(): Promise<ModelMessage[]> {
    const file = Bun.file(this.filePath);

    if (!(await file.exists())) {
      return [];
    }

    const content = (await file.text()).trim();
    if (!content) {
      return [];
    }

    const messages: ModelMessage[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry: MessageEntry = JSON.parse(line);
        if (entry.type === "message") {
          messages.push(entry.message);
        }
      } catch (error) {
        console.error(`[session store]: read line error: ${error}`);
      }
    }
    return messages;
  }

  exists() {
    return Bun.file(this.filePath).exists();
  }
}
