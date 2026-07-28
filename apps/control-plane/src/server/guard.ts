import { redirect } from 'next/navigation'
import { authorize, type Actor, type Capability } from '../auth/authorize'
import { getCurrentActor } from './current-user'

export async function requireUser(): Promise<Actor> {
  const actor = await getCurrentActor()
  if (!actor) redirect('/login')
  return actor
}

export async function requireCapabilityOr403(action: Capability): Promise<Actor> {
  const actor = await requireUser()
  // The (app) route group is stripped from the URL, so its index serves at '/'.
  if (!authorize(actor, action)) redirect('/?forbidden=1')
  return actor
}
