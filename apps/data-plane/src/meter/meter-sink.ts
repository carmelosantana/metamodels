import type { MeterDim } from '@metamodels/schema'

export interface MeterEventRecord {
  orgId: string
  keyId: string
  paddockId: string
  breedId: string
  dim: MeterDim
  value: number
  at: number
}

export interface MeterSink {
  emit(events: MeterEventRecord[]): Promise<void>
}

export class InMemoryMeterSink implements MeterSink {
  readonly events: MeterEventRecord[] = []

  async emit(events: MeterEventRecord[]): Promise<void> {
    this.events.push(...events)
  }
}
