import { problem } from '../../../../../../server/problem'

/**
 * Keys are never hard-deleted: `revokeKey` sets status only, and three usage_* tables cascade off
 * key_id. DELETE means "gone" on every other resource of this API, so it must not mean "revoked"
 * here (spec §2.1).
 *
 * Refused rather than quietly re-routed, because the two meanings are not interchangeable: a client
 * calling DELETE wants the key and its history gone, and answering 204 after merely flipping a
 * status would tell it something untrue about a billing record. `usage_*.key_id` is
 * ON DELETE CASCADE, so the honest reading of DELETE would destroy usage history no audit row could
 * reconstruct. The body names the operation that does exist so the caller's next request is right.
 *
 * Deliberately NOT wrapped in `withAdmin`: the answer does not depend on who is asking, touches no
 * database and can never act, so requiring a verified token first would only make an unconditional
 * refusal cost a JWKS round trip. Nothing is disclosed — the route's existence is published (spec
 * §2.1), and no id is echoed or looked up.
 *
 * `Allow` is empty because that is the truth about this URI, and RFC 9110 §15.5.6 makes the field
 * mandatory on a 405: `/keys/{id}` exports no other method, so it supports none. RFC 9110 §10.2.1
 * gives an empty field value exactly that meaning. The same instinct as `unauthorized()`'s
 * always-present challenge — a mandatory header belongs at the one place the response is built.
 */
export function DELETE(): Response {
  return problem(405, 'Method Not Allowed',
    'API keys are revoked, not deleted — POST /api/admin/v1/keys/{id}/revoke',
    undefined, { allow: '' })
}
