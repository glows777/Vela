import { APICallError } from "@ai-sdk/provider";

// --- 错误分类 ---

export function isRetryable(error: unknown): boolean {
  // provider 的 HTTP 错误：message 是响应体里的说明（如 "Rate limit reached ..."），不含状态码，
  // 按 statusCode 判断（AI SDK 默认 408/409/429/5xx 可重试）
  if (APICallError.isInstance(error)) return error.isRetryable;
  if (!(error instanceof Error)) return false;

  const message = error.message || "";

  // HTTP 状态码判断
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1]!);
    // 429 Too Many Requests, 529 Site is overloaded, 408 Request Timeout
    // 这些状态码通常表示请求过多或服务器暂时无法处理请求，适合重试
    if ([429, 529, 408].includes(status)) return true;

    // 5xx 错误通常表示服务器错误，适合重试
    if (status >= 500 && status < 600) return true;

    // 4xx 错误通常表示客户端错误，不适合重试
    if (status >= 400 && status < 500) return false;
  }

  // ECONNRESET 连接被重置，EPIPE 管道破裂，ETIMEDOUT 请求超时，fetch failed 或 network 表示网络问题，这些都适合重试
  if (message.includes("ECONNRESET") || message.includes("EPIPE")) return true;
  if (message.includes("ETIMEDOUT") || message.includes("timeout")) return true;
  if (message.includes("fetch failed") || message.includes("network"))
    return true;
  // AI SDK 会把流式错误包装成 NoOutputGeneratedError, 这种错误通常表示模型没有生成输出，可能是暂时的模型问题，适合重试
  if (message.includes("No output generated")) return true;

  return false;
}

// --- 指数退避 + 随机抖动 ---
export function calculateDelay(
  attempt: number,
  baseMs = 500,
  maxMs = 30000,
): number {
  const exponential = baseMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, maxMs);
  const jitterRange = capped * 0.25;
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(jittered));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
