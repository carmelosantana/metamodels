import { notFound, redirect } from 'next/navigation'
import { authorize, type Actor, type Capability } from '../auth/authorize'
import { getCurrentActor } from './current-user'

export async function requireUser(): Promise<Actor> {
  const actor = await getCurrentActor()
  if (!actor) redirect('/login')
  return actor
}

/** Page guard for capability-restricted screens. Unauthenticated → /login; authorized-but-lacking
 *  the capability → 404 (does not reveal the page exists); otherwise returns the Actor. */
export async function requireCapabilityOr403(cap: Capability): Promise<Actor> {
  const actor = await requireUser()
  if (!authorize(actor, cap)) notFound()
  return actor
}
