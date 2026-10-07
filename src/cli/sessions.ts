/** CLI 每次启动的新会话 id（同 pi 每次一个新会话）：本地时间 + 4 位随机，可排序也好认。 */
export function newSessionId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const random = crypto.randomUUID().slice(0, 4)
  return `${date}-${time}-${random}`
}
