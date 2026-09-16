const MAX_FAILURES = 5
const WINDOW_MS = 15 * 60_000

interface Bucket { count: number; resetAt: number }

export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>()

  check(ip: string, nowMs: number): boolean {
    const b = this.buckets.get(ip)
    if (!b || nowMs >= b.resetAt) return true
    return b.count < MAX_FAILURES
  }

  record(ip: string, nowMs: number): void {
    const b = this.buckets.get(ip)
    if (!b || nowMs >= b.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: nowMs + WINDOW_MS })
      return
    }
    b.count += 1
  }
}
