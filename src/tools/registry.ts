import type { Client, Transport } from "@modelcontextprotocol/client";
import type { FlexibleSchema, Tool, ToolSet } from "ai";
import { tool as AITool, type JSONSchema7, jsonSchema } from "ai";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<any>;
  execute: (input: any) => Promise<unknown>;

  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;

  shouldDefer?: boolean; // 是否延迟加载
  searchHint?: string; // 搜索提示词，帮助 ToolSearch 匹配
}

const DEFAULT_MAX_RESULT_CHARS = 3000; // 默认最大结果字符数， 超出则截断

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  // 当前锁设计的已知缺陷：
  // 1. 锁粒度是整个 ToolRegistry；一个独占工具执行时，不相关的工具也会被阻塞。
  // 2. 没有资源级 lock key，无法表达“同一文件串行、不同文件并行”这类更细的关系。
  // 3. acquireConcurrent 只检查 exclusiveLock，不检查是否已有独占任务在等待，读任务可能插队写任务。
  // 4. drainQueue 会一次性唤醒所有等待者，再由 while 重新竞争，不保证严格 FIFO 公平性。
  private exclusiveLock = false; // 当前是否有独占锁持有者
  private concurrentCount = 0; // 当前共享锁持有数
  private waitQueue: Array<() => void> = []; // 阻塞等待中的 resolve 函数

  private discoveredTools = new Set<string>();

  // * 获取共享锁
  private async acquireConcurrent() {
    while (this.exclusiveLock) {
      await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    }
    this.concurrentCount++;
  }

  // 获取独占锁
  // 等待所有共享锁释放且没有独占锁
  private async acquireExclusive() {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((reslove) => this.waitQueue.push(reslove));
    }
    this.exclusiveLock = true;
  }

  // * 释放 共享锁
  // * 如果当前已经释放了全部，则唤醒等待队列
  private releaseConcurrent() {
    this.concurrentCount--;
    if (this.concurrentCount === 0) {
      this.drainQueue();
    }
  }

  // * 释放独占锁，唤醒等待队列
  private releaseExclusive() {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  private drainQueue() {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) {
      resolve();
    }
  }

  register(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(
          `[Tool ToolRegistry] Tool with name "${tool.name}" is already registered.`,
        );
      }
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toAISDKFormat(): ToolSet {
    const result: Record<string, Tool> = {};

    const activeTools = this.getActiveTools();

    for (const tool of activeTools) {
      const maxChar = tool.maxResultChars;
      const excuteFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const currentRegistryScope = this;
      const name = tool.name;

      result[name] = AITool({
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (input: unknown) => {
          if (isSafe) {
            await currentRegistryScope.acquireConcurrent();
            console.log(`  [concurrentCount] ${name} get concurrent lock`);
          } else {
            await currentRegistryScope.acquireExclusive();
            console.log(
              `  [parrcell] ${name} get exclusiveLock，waiting other tool called`,
            );
          }
          try {
            const raw = await excuteFn(input);
            const text =
              typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);

            return truncateResult(text, maxChar ?? DEFAULT_MAX_RESULT_CHARS);
          } finally {
            // 释放锁
            if (isSafe) {
              currentRegistryScope.releaseConcurrent();
            } else {
              currentRegistryScope.releaseExclusive();
            }
          }
        },
      });
    }
    return result;
  }

  private mcpClients: Array<Client> = [];

  async registerMCPServer(
    serverName: string,
    client: Client,
    transport: Transport,
  ): Promise<string[]> {
    await client.connect(transport);
    this.mcpClients.push(client);

    const tools = await listAllMCPTools(client);
    const registered: string[] = [];

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`;
      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description ?? ""}`,
        inputSchema: jsonSchema(tool.inputSchema as JSONSchema7),
        // readOnlyHint is only an MCP behavior hint, not a concurrency contract.
        // Treat it as a conservative signal: unknown or mutating MCP tools run exclusively.
        isConcurrencySafe: true,
        isReadOnly: tool.annotations?.readOnlyHint === true,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        maxResultChars: 3000,
        execute: async (input: any) => {
          const result = await toolClient.callTool({
            name: originalName,
            arguments: input,
          });
          return formatMCPToolResult(result);
        },
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }

  getActiveTools() {
    return this.getAllTools().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      return true;
    });
  }

  getDeferredToolSummary(): string {
    const deferred = this.getAllTools().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name);
    });

    if (deferred.length === 0) return "";

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : "";
      return `  - ${t.name}${hint}`;
    });
    // 以下工具可用，但需要先通过 tool_search 搜索获取完整定义
    return `\nBelow tools can be call, but before you call these tools, you should call too_search tool to get the competed tool schema
    ${lines.join("\n")}`;
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim();
    const results: ToolDefinition[] = [];

    const names = q.includes(",")
      ? q
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
      : [q];

    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool && tool.name !== "tool_search") {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }
    return results;
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }).length;
      const tokens = Math.ceil(schemaSize / 4);

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return { active, deferred, total: active + deferred };
  }
}

function truncateResult(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n...[ ${dropped} text has been truncated ] ...\n\n${tail}`;
}

async function listAllMCPTools(client: Client) {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);

  return tools;
}

function formatMCPToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  const content = result.content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      return JSON.stringify(block, null, 2);
    })
    .filter((text) => text.length > 0)
    .join("\n");
  const structuredContent = result.structuredContent
    ? `\n\nstructuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}`
    : "";
  const errorPrefix = result.isError ? "[MCP tool error]\n" : "";

  return `${errorPrefix}${content}${structuredContent}` || "empty response";
}
