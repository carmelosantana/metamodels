import { authorize, type Capability, type Role } from './authorize'

export interface NavItem {
  href: string
  label: string
  capability: Capability
}

const ALL_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', capability: 'read' },
  { href: '/flocks', label: 'Flocks', capability: 'resource.write' },
  { href: '/paddocks', label: 'Paddocks', capability: 'resource.write' },
  { href: '/keys', label: 'API Keys', capability: 'resource.write' },
  { href: '/usage', label: 'Usage', capability: 'read' },
  { href: '/audit', label: 'Audit', capability: 'read' },
  { href: '/team', label: 'Team', capability: 'user.manage' },
  { href: '/settings', label: 'Settings', capability: 'license.manage' },
]

export function navItemsForRole(role: Role): NavItem[] {
  return ALL_ITEMS.filter((i) => authorize({ role }, i.capability))
}
