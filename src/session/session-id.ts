/** Id for a new session the CLI or fork() starts (like pi): local time + 4 random chars, sortable and readable. */
export function newSessionId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const random = crypto.randomUUID().slice(0, 4)
  return `${date}-${time}-${random}`
}
