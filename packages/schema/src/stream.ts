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
