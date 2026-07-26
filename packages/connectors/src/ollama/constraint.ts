import { z } from 'zod'

export const ollamaConstraint = z.object({
  allowedRoutes: z.array(z.enum(['chat', 'generate', 'embed', 'read'])).min(1).default(['chat']),
  allowedModels: z.array(z.string()).nullable().default(null),
})

export type OllamaConstraint = z.infer<typeof ollamaConstraint>

export type OllamaRouteGroup = 'chat' | 'generate' | 'embed' | 'read' | 'mutate' | 'unknown'

export function routeGroup(path: string): OllamaRouteGroup {
  const p = path.split('?')[0]
  if (p === '/api/chat' || p === '/v1/chat/completions') return 'chat'
  if (p === '/api/generate' || p === '/v1/completions') return 'generate'
  if (p === '/api/embed' || p === '/api/embeddings' || p === '/v1/embeddings') return 'embed'
  if (
    p === '/api/tags' || p === '/api/show' || p === '/api/ps' || p === '/api/version' ||
    p === '/v1/models' || p.startsWith('/v1/models/')
  ) return 'read'
  if (
    p === '/api/pull' || p === '/api/push' || p === '/api/create' ||
    p === '/api/copy' || p === '/api/delete' || p.startsWith('/api/blobs')
  ) return 'mutate'
  return 'unknown'
}
