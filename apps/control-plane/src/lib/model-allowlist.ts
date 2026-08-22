/** Split saved allowlist entries into those the server currently has ("present", shown as
 *  checked boxes) and those it does not ("manual", e.g. not pulled yet — shown as chips so
 *  a model can be pre-authorized before it exists on the box). */
export function partitionAllowlist(
  saved: string[],
  live: string[],
): { present: string[]; manual: string[] } {
  const liveSet = new Set(live)
  return {
    present: saved.filter((m) => liveSet.has(m)),
    manual: saved.filter((m) => !liveSet.has(m)),
  }
}

/** Serialize a selection to the comma-separated `models` field the save action parses.
 *  Order-stable, trimmed, de-duplicated; empty ⇒ '' which the action reads as "any model". */
export function serializeAllowlist(selected: string[]): string {
  return [...new Set(selected.map((s) => s.trim()).filter(Boolean))].join(', ')
}
