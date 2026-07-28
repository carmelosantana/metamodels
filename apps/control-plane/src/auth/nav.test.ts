import { describe, expect, test } from 'vitest'
import { navItemsForRole } from './nav'

describe('navItemsForRole', () => {
  test('viewer sees only read surfaces (no Flocks/Team)', () => {
    const labels = navItemsForRole('viewer').map((i) => i.label)
    expect(labels).toContain('Dashboard')
    expect(labels).toContain('Usage')
    expect(labels).toContain('Audit')
    expect(labels).not.toContain('Flocks')
    expect(labels).not.toContain('Team')
  })

  test('member sees resource surfaces but not Team/Settings', () => {
    const labels = navItemsForRole('member').map((i) => i.label)
    expect(labels).toContain('Flocks')
    expect(labels).not.toContain('Team')
    expect(labels).not.toContain('Settings')
  })

  test('admin sees everything including Team and Settings', () => {
    const labels = navItemsForRole('admin').map((i) => i.label)
    expect(labels).toContain('Flocks')
    expect(labels).toContain('Team')
    expect(labels).toContain('Settings')
  })
})
