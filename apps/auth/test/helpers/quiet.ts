import { onTestFinished, vi } from 'vitest'

/**
 * Swallow one console method for the rest of the current test, and hand back its spy so the test can
 * assert what was logged. For tests that provoke a failure whose log line is the production behaviour
 * being kept: the line is proven, not printed to the run's stderr.
 */
export function quiet(method: 'warn' | 'error') {
  const spy = vi.spyOn(console, method).mockImplementation(() => {})
  onTestFinished(() => spy.mockRestore())
  return spy
}
