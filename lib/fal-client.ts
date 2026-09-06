import { fal as rawFal } from '@fal-ai/client'
import { signPayload, FAL_TTL } from './media-url'

/**
 * The fal client, with every private media URL signed on the way out.
 *
 * fal is a third party: whatever URL we put in a job's input is fetched from
 * their infrastructure and kept in their job record. It must therefore never
 * be a permanent, unauthenticated link to a user's file. Since the bucket went
 * private such a link would not work anyway — but "it broke" is a much worse
 * way to find out than "it was signed automatically".
 *
 * This is a wrapper rather than a fetch shim because `fal.config()` REPLACES
 * the client configuration wholesale (`{...DEFAULT_CONFIG, ...config}`, with
 * `fetch` reset when absent), and twenty-odd routes call
 * `fal.config({ credentials })` at module load. A fetch installed once would be
 * silently discarded by whichever route happened to import last — the exact
 * kind of failure that looks fine until a user's file leaks.
 *
 * It is a Proxy rather than a hand-written facade so that a fal client method
 * nobody has used yet cannot quietly bypass it.
 */

/** Sign the `input` of a submit/subscribe/run/stream options object. */
function signOptions(args: unknown[]): unknown[] {
  const [endpoint, options] = args
  if (!options || typeof options !== 'object' || !('input' in options)) return args
  const signed = { ...(options as Record<string, unknown>) }
  signed.input = signPayload(signed.input, FAL_TTL)
  return [endpoint, signed, ...args.slice(2)]
}

const SIGNED_METHODS = new Set(['subscribe', 'run', 'stream'])

function wrap<T extends object>(target: T, methods: Set<string>): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver)
      if (typeof prop === 'string' && methods.has(prop) && typeof value === 'function') {
        return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(obj, signOptions(args))
      }
      // The queue is a nested object with its own submitting method.
      if (prop === 'queue' && value && typeof value === 'object') {
        return wrap(value as object, new Set(['submit']))
      }
      return typeof value === 'function' ? value.bind(obj) : value
    },
  })
}

export const fal = wrap(rawFal, SIGNED_METHODS)
