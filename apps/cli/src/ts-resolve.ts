import { registerHooks } from 'node:module'

/**
 * Lets plain `node` load this repo's TypeScript sources, which import each other as `./x.js` (the
 * `tsc` convention this workspace uses everywhere, `@metamodels/schema` included). Node strips the
 * types but resolves specifiers literally, so `./x.js` is not found when only `x.ts` exists.
 *
 * Narrow on purpose: only a relative `.js` specifier, only from a `.ts` module, and only after the
 * normal resolution has failed with ERR_MODULE_NOT_FOUND. Everything else resolves untouched.
 * Loaded with `node --import` so it is in place before the entry module is linked. Zero-dependency:
 * `module.registerHooks` is Node's own synchronous resolve hook.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (e) {
      const retry = (e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' &&
        (specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') &&
        context.parentURL?.endsWith('.ts') === true
      if (!retry) throw e
      return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context)
    }
  },
})
