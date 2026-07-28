/** Redis stream key the data-plane XADDs meter events to and the worker consumes. */
export const METER_STREAM_KEY = 'metamodels:meters'
/** Consumer group name the worker reads under. */
export const METER_GROUP = 'rollup'

export interface MeterStreamEvent {
  orgId: string
  keyId: string
  paddockId: string
  breedId: string
  dim: string
  value: number
  at: number
}

/** Encode an event as a single-field XADD map: `{ data: <json> }`. */
export function encodeMeterEvent(e: MeterStreamEvent): Record<string, string> {
  return { data: JSON.stringify(e) }
}

/** Decode a flat `[field, value, field, value, …]` XREADGROUP field array back to an event. */
export function decodeMeterEvent(fields: string[]): MeterStreamEvent {
  const i = fields.indexOf('data')
  if (i < 0 || i + 1 >= fields.length) throw new Error('meter stream entry missing `data` field')
  return JSON.parse(fields[i + 1]) as MeterStreamEvent
}

/** Redis pub/sub channel the control-plane PUBLISHes to on any config write and the
 * data-plane SUBSCRIBEs to, to invalidate its cached key/paddock/fence config. */
export const CONFIG_INVALIDATE_CHANNEL = 'metamodels:config:invalidate'

/** A config-invalidation signal. `reason` is a human/audit hint (e.g. 'flock.save'); the
 * data-plane flushes its whole config cache regardless of reason. `at` is emit time (ms). */
export interface ConfigInvalidation {
  reason: string
  at: number
}

export function encodeConfigInvalidation(reason: string, at: number): string {
  return JSON.stringify({ reason, at })
}

export function decodeConfigInvalidation(payload: string): ConfigInvalidation {
  const o = JSON.parse(payload) as unknown
  if (
    typeof o !== 'object' || o === null ||
    typeof (o as { reason?: unknown }).reason !== 'string' ||
    typeof (o as { at?: unknown }).at !== 'number'
  ) {
    throw new Error('invalid config-invalidation payload')
  }
  return o as ConfigInvalidation
}
