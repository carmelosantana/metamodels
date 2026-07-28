import type { BreedRegistry } from '@metamodels/connectors'

/**
 * Validate a fence's constraint_json against the paddock's breed. Returns the
 * parsed constraint (breed defaults applied). Throws the registry's error for
 * an unknown breed, or a ZodError for an invalid constraint. This is where
 * `mutate` exposure is structurally impossible: the Ollama constraint enum has
 * no `mutate` member.
 */
export function validateConstraintForBreed(
  registry: BreedRegistry,
  breedId: string,
  constraintJson: unknown,
): unknown {
  const breed = registry.get(breedId)
  return breed.constraintSchema.parse(constraintJson)
}
