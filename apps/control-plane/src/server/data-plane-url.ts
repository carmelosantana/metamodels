import { requireOrigin } from '@metamodels/schema'

/** `DATA_PLANE_URL`, validated as an origin. Read per call, as the rest of this server reads its config. */
export function loadDataPlaneUrl(): string {
  return requireOrigin('DATA_PLANE_URL', process.env.DATA_PLANE_URL)
}
