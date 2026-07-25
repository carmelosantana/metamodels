import type { Breed } from './breed.js'

export class BreedRegistry {
  private readonly breeds = new Map<string, Breed<unknown>>()

  register(breed: Breed<unknown>): void {
    if (this.breeds.has(breed.id)) {
      throw new Error(`Breed already registered: ${breed.id}`)
    }
    this.breeds.set(breed.id, breed)
  }

  get(id: string): Breed<unknown> {
    const breed = this.breeds.get(id)
    if (!breed) throw new Error(`Unknown breed: ${id}`)
    return breed
  }

  has(id: string): boolean {
    return this.breeds.has(id)
  }

  ids(): string[] {
    return [...this.breeds.keys()]
  }
}
