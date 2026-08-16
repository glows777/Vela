/**
 * Mock Model v0.10 — 模拟 prompt cache 行为
 *
 * 拿 system + tools 的指纹做"前缀稳定性"判断：
 * - 第一次见的 prefix → 全部记 cacheWrite
 * - 跟上一次一模一样 → 全部记 cacheRead
 * - prefix 变了（system 改了、工具增减、注入了时间戳）→ 又一次 cacheWrite
 *
 * 这样在 /context、/usage 视图里能直观看到 cache 命中率随对话推进上涨。
 */

let retryTestCount = 0;
let lastPrefixHash: string | null = null;
let cacheEnabled = true;

export function setCacheEnabled(enabled: boolean): void {
  cacheEnabled = enabled;
  if (!enabled) lastPrefixHash = null;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function approxTokensFromChars(chars: number): number {
  return Math.ceil(chars / 3.5);
}

function extractSystemContent(prompt: any[]): string {
  const sys = (prompt || []).find((m: any) => m.role === 'system');
  if (!sys) return '';
  if (typeof sys.content === 'string') return sys.content;
  if (Array.isArray(sys.content)) return sys.content.map((c: any) => c.text || '').join('');
  return '';
}

function approxMessageTokens(prompt: any[]): number {
  let chars = 0;
  for (const m of prompt || []) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const c of m.content as any[]) {
        if (c.type === 'text') chars += (c.text || '').length;
        else if (c.type === 'tool-call') chars += JSON.stringify(c.input || {}).length + 80;
        else if (c.type === 'tool-result') {
          const out = c.output;
          if (typeof out === 'string') chars += out.length;
          else if (out?.value) chars += String(out.value).length;
          else chars += JSON.stringify(out || {}).length;
          chars += 80;
        }
      }
    }
  }
  return approxTokensFromChars(chars);
}

/** 根据 prompt 算这次调用的 usage，并模拟 cache 命中。 */
function makeUsage(prompt: any[], outputChars = 80) {
  const system = extractSystemContent(prompt);
  const prefixContent = system;
  const prefixTokens = approxTokensFromChars(prefixContent.length);
  const messageTokens = approxMessageTokens(prompt);
  const outputTokens = approxTokensFromChars(outputChars);

  // 真实模型最小阈值各家不一（Qwen implicit 256、OpenAI 1024、Sonnet 4.7 2048、Opus 4.7 4096）。
  // 课程里用 512 让普通 SYSTEM 也能演示 cache 行为，等到讲生产配置时再讲各家阈值差异。
  const MIN_CACHE = 512;
  const cacheable = cacheEnabled && prefixTokens >= MIN_CACHE;

  const prefixHash = cacheable ? simpleHash(prefixContent) : null;
  let cacheRead = 0;
  let cacheWrite = 0;
  let input = messageTokens;

  if (cacheable) {
    if (lastPrefixHash === prefixHash) {
      cacheRead = prefixTokens;
    } else {
      cacheWrite = prefixTokens;
    }
    lastPrefixHash = prefixHash;
  } else {
    input += prefixTokens;
    lastPrefixHash = null;
  }

  // 返回 AI SDK v5 标准字段（number），跟真实模型一致
  // cacheCreationInputTokens 是 Anthropic provider 元数据里的字段名，AI SDK 透传
  return {
    inputTokens: input,
    outputTokens: outputTokens,
    totalTokens: input + outputTokens,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
  };
}

const TEXT_RESPONSES: Record<string, string> = {
  default:
    '你好！我是 Super Agent v0.10。试试 /context 看上下文占用，/usage 看 token 用量和缓存命中率，/cache off 关掉缓存对比成本差异。',
  greeting:
    '你好！我是 Super Agent v0.10，已经接上 prompt cache 和成本追踪 :) 多聊几轮，输入 /usage 看节省了多少。',
};

interface ToolCallIntent {
  toolName: string;
  args: Record<string, unknown>;
}

function extractUserText(prompt: any[]): string {
  const userMsgs = (prompt || []).filter((m: any) => m.role === 'user');
  const last = userMsgs[userMsgs.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content.toLowerCase();
  return (last.content || [])
    .map((c: any) => c.text || '')
    .join('')
    .toLowerCase();
}

function hasToolResults(prompt: any[]): boolean {
  const msgs = prompt || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'tool') return true;
    if (msgs[i].role === 'user') return false;
  }
  return false;
}

function getToolResultContent(prompt: any[]): string {
  const msgs = prompt || [];
  const parts: string[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'tool') {
      const content = msgs[i].content || [];
      for (const c of content) {
        const val = c.output?.value || c.output || c.result || '';
        parts.push(String(val));
      }
    } else if (msgs[i].role === 'user') break;
  }
  return parts.join('\n');
}

function wasToolSearchCalled(prompt: any[]): boolean {
  const msgs = prompt || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      const content = msgs[i].content || [];
      for (const c of content) {
        if (c.type === 'tool-call' && c.toolName === 'tool_search') return true;
      }
    }
    if (msgs[i].role === 'user') return false;
  }
  return false;
}

function detectParallelIntent(text: string): ToolCallIntent[] | null {
  if (text.includes('测试并发') || text.includes('test parallel')) {
    return [
      { toolName: 'get_weather', args: { city: '北京' } },
      { toolName: 'get_weather', args: { city: '上海' } },
      { toolName: 'list_directory', args: { path: '.' } },
    ];
  }
  return null;
}

function detectToolIntent(prompt: any[]): ToolCallIntent | null {
  const text = extractUserText(prompt);
  const toolResults = getToolResultContent(prompt);

  if (text.includes('测试死循环')) {
    return { toolName: 'get_weather', args: { city: '北京' } };
  }

  // 如果刚刚 tool_search 返回了结果，现在要调用发现的工具
  if (hasToolResults(prompt) && wasToolSearchCalled(prompt)) {
    if (toolResults.includes('list_issues') || toolResults.includes('mcp__github')) {
      const repoMatch = text.match(/(\w+)\/(\w[\w-]*)/);
      const owner = repoMatch ? repoMatch[1] : 'vercel';
      const repo = repoMatch ? repoMatch[2] : 'ai';
      return { toolName: 'mcp__github__list_issues', args: { owner, repo } };
    }
    if (toolResults.includes('search_pages') || toolResults.includes('mcp__notion')) {
      return { toolName: 'mcp__notion__search_pages', args: { query: 'project roadmap' } };
    }
    if (toolResults.includes('navigate') || toolResults.includes('mcp__browser')) {
      return { toolName: 'mcp__browser__navigate', args: { url: 'https://example.com' } };
    }
    if (toolResults.includes('supabase') || toolResults.includes('mcp__supabase')) {
      return { toolName: 'mcp__supabase__list_tables', args: {} };
    }
    return null;
  }

  if (hasToolResults(prompt)) return null;

  // 延迟工具场景：先 tool_search，传精确的工具名
  if (text.includes('issue') || text.includes('issues') || text.includes('github')) {
    return { toolName: 'tool_search', args: { query: 'mcp__github__list_issues' } };
  }
  if (text.includes('notion') || text.includes('笔记') || text.includes('文档')) {
    return { toolName: 'tool_search', args: { query: 'mcp__notion__search_pages' } };
  }
  if (text.includes('浏览器') || text.includes('browser') || text.includes('网页')) {
    return { toolName: 'tool_search', args: { query: 'mcp__browser__navigate' } };
  }
  if (text.includes('数据库') || text.includes('database') || text.includes('supabase') || text.includes('sql')) {
    return { toolName: 'tool_search', args: { query: 'mcp__supabase__list_tables' } };
  }

  // 内置工具（非延迟，直接调用）
  if (text.includes('测试截断') || text.includes('test truncation')) {
    return { toolName: 'read_file', args: { path: 'sample-data.txt' } };
  }
  if (text.includes('测试编辑') || text.includes('test edit')) {
    return { toolName: 'edit_file', args: { path: 'sample-data.txt', old_string: '一、工具注册机制', new_string: '一、工具注册机制（已更新）' } };
  }
  if (text.includes('测试搜索') || text.includes('test grep')) {
    return { toolName: 'grep', args: { pattern: 'export', path: 'src' } };
  }
  if (text.includes('测试glob') || text.includes('test glob')) {
    return { toolName: 'glob', args: { pattern: '**/*.ts' } };
  }
  if (text.includes('测试bash') || text.includes('test bash')) {
    return { toolName: 'bash', args: { command: 'echo "Hello from bash!" && date' } };
  }
  if (text.includes('目录') || text.includes('文件列表') || text.includes('ls')) {
    return { toolName: 'list_directory', args: { path: '.' } };
  }

  const fileMatch = text.match(/(\S+\.[\w]+)/);
  if (fileMatch && (text.includes('读') || text.includes('read') || text.includes('看看') || text.includes('查看') || text.includes('打开') || text.includes('文件') || text.includes('file'))) {
    return { toolName: 'read_file', args: { path: fileMatch[1] } };
  }

  const weatherKeywords = ['天气', 'weather', '温度', '热', '冷', '气温'];
  const hasWeatherIntent = weatherKeywords.some((kw) => text.includes(kw));
  const cities = text.match(/(北京|上海|深圳|广州|杭州|成都)/g);
  if (hasWeatherIntent && cities && cities.length > 0) {
    return { toolName: 'get_weather', args: { city: cities[0] } };
  }

  const calcMatch = text.match(/(\d+)\s*[+\-*/加减乘除]\s*(\d+)/);
  if (calcMatch) {
    const op = text.match(/[+*/]|加|减|乘|除|-/)?.[0] || '+';
    const opMap: Record<string, string> = { '加': '+', '减': '-', '乘': '*', '除': '/' };
    const expression = `${calcMatch[1]} ${opMap[op] || op} ${calcMatch[2]}`;
    return { toolName: 'calculator', args: { expression } };
  }

  return null;
}

function pickTextResponse(prompt: any[]): string {
  if (hasToolResults(prompt)) {
    const combined = getToolResultContent(prompt);

    if (combined.includes('[DIR]') || combined.includes('[FILE]')) {
      return `当前目录的文件列表：\n${combined}`;
    }
    if (combined.includes('°C') || combined.includes('天气')) {
      return `根据查询结果：${combined}`;
    }
    if (combined.includes('已发送') || combined.includes('已导航') || combined.includes('已点击') || combined.includes('已填写')) {
      return `操作完成：${combined}`;
    }
    if (combined.includes('number') || combined.includes('title') || combined.includes('state')) {
      return `查询结果：\n${combined}`;
    }
    return `工具返回了以下信息：\n${combined}`;
  }

  const text = extractUserText(prompt);
  if (text.includes('你好') || text.includes('hello') || text.includes('hi'))
    return TEXT_RESPONSES.greeting;
  return TEXT_RESPONSES.default;
}

function createDelayedStream(chunks: any[], delayMs = 30): ReadableStream {
  return new ReadableStream({
    start(controller) {
      let i = 0;
      function next() {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
          setTimeout(next, delayMs);
        } else {
          controller.close();
        }
      }
      next();
    },
  });
}

function makeToolCallChunks(intents: ToolCallIntent[], prompt: any[]): any[] {
  const chunks: any[] = [];
  for (const intent of intents) {
    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const argsJson = JSON.stringify(intent.args);
    chunks.push(
      { type: 'tool-input-start', id: callId, toolName: intent.toolName },
      { type: 'tool-input-delta', id: callId, delta: argsJson },
      { type: 'tool-input-end', id: callId },
      { type: 'tool-call', toolCallId: callId, toolName: intent.toolName, input: argsJson },
    );
  }
  chunks.push({ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: makeUsage(prompt) });
  return chunks;
}

export function createMockModel() {
  return {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'mock-model',

    get supportedUrls() {
      return Promise.resolve({});
    },

    async doGenerate({ prompt }: any) {
      // Detect compression request (called via generateText with compress system prompt)
      const allText = (prompt || []).map((m: any) => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.map((c: any) => c.text || '').join('');
        return '';
      }).join(' ');

      if (allText.includes('对话压缩系统') || allText.includes('压缩成一份结构化摘要')) {
        const mockSummary = `## 用户意图\n用户在探索项目结构和代码，了解工具系统的设计。\n\n## 已完成的操作\n- 列出了当前目录文件（.env, package.json, sample-data.txt, src/）\n- 读取了 package.json（项目名 super-agent-08-compaction, 版本 0.8.0）\n- 读取了 sample-data.txt（工具系统设计文档）\n- 搜索了 src/ 目录中的 export（找到 ToolRegistry, agentLoop, SessionStore 等导出）\n\n## 关键发现\n- 项目使用 ai@5.0.98 和 @ai-sdk/openai@2.0.44\n- 工具系统包含 ToolRegistry、truncateResult、并发控制（读写锁）\n- 已实现 SessionStore（JSONL 持久化）和 PromptBuilder（模块化 Prompt）\n\n## 当前状态\n用户刚完成项目结构探索，尚未开始修改代码。\n\n## 需要保留的细节\n- 项目路径：当前工作目录\n- 关键文件：src/tool-registry.ts, src/agent-loop.ts, src/context-compressor.ts`;
        return {
          content: [{ type: 'text' as const, text: mockSummary }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: makeUsage(prompt),
          warnings: [],
        };
      }

      const text = extractUserText(prompt);

      if (text.includes('测试重试') || text.includes('test retry')) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error('429 Too Many Requests - Rate limit exceeded');
        }
        retryTestCount = 0;
        return {
          content: [{ type: 'text' as const, text: '重试成功！' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: makeUsage(prompt),
          warnings: [],
        };
      }

      const parallelIntents = detectParallelIntent(text);
      if (parallelIntents && !hasToolResults(prompt)) {
        return {
          content: parallelIntents.map(intent => ({
            type: 'tool-call' as const,
            toolCallId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            toolName: intent.toolName,
            input: intent.args,
          })),
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: makeUsage(prompt),
          warnings: [],
        };
      }

      const intent = detectToolIntent(prompt);
      if (intent) {
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: `call-${Date.now()}`,
            toolName: intent.toolName,
            input: intent.args,
          }],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: makeUsage(prompt),
          warnings: [],
        };
      }

      return {
        content: [{ type: 'text' as const, text: pickTextResponse(prompt) }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: makeUsage(prompt),
        warnings: [],
      };
    },

    async doStream({ prompt }: any) {
      const text = extractUserText(prompt);

      if (text.includes('测试重试') || text.includes('test retry')) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error('429 Too Many Requests - Rate limit exceeded');
        }
        retryTestCount = 0;
        const reply = '重试成功！';
        const id = 'text-1';
        const chunks: any[] = [
          { type: 'text-start', id },
          ...reply.split('').map((char: string) => ({ type: 'text-delta', id, delta: char })),
          { type: 'text-end', id },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: makeUsage(prompt) },
        ];
        return { stream: createDelayedStream(chunks, 30) };
      }

      const parallelIntents = detectParallelIntent(text);
      if (parallelIntents && !hasToolResults(prompt)) {
        return { stream: createDelayedStream(makeToolCallChunks(parallelIntents, prompt), 15) };
      }

      const intent = detectToolIntent(prompt);
      if (intent) {
        return { stream: createDelayedStream(makeToolCallChunks([intent], prompt), 20) };
      }

      const replyText = pickTextResponse(prompt);
      const id = 'text-1';
      const chunks: any[] = [
        { type: 'text-start', id },
        ...replyText.split('').map((char: string) => ({ type: 'text-delta', id, delta: char })),
        { type: 'text-end', id },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: makeUsage(prompt) },
      ];
      return { stream: createDelayedStream(chunks, 30) };
    },
  };
}
