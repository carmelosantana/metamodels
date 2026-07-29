// Liveness probe for the container healthcheck. Intentionally does NOT touch the DB —
// it answers "is the Next server up?", not "is every dependency ready?". Keep it dependency-free
// so a slow/unavailable Postgres never flaps the control-plane's own health status.
export function GET(): Response {
  return Response.json({ status: 'ok' })
}
