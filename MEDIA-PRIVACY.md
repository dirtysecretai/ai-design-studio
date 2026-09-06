# Private media — what changed, and how to switch it on

Until now every generated image, video, 3D asset and reference lived on a
**world-readable** R2 bucket. Anyone holding a URL could fetch it forever with
no session — verified against production: three generated images and a
reference thumbnail all returned `200` to an unauthenticated request. That
covered **86,155 generations across 621 users** and 413 references. The
`ref-thumb/{id}.webp` keys were the raw row id, so the reference library was
also *enumerable*, not merely exposed.

Now: the bucket is private, and the only way in is a URL the app signs.

## How it works

**Ownership is decided in Postgres**, at the moment a URL is handed out, by the
route that already knows whose row it is. The signature carries that decision
to the edge. The Worker is stateless — no database, no KV, nothing to fall out
of sync — which is also why **none of the 86,000 existing objects had to be
moved or renamed**.

```
browser ──> app (session + row ownership) ──> signed URL
                                                  │
                                                  v
                              media Worker (verify HMAC + expiry) ──> private R2
```

The signature covers the key **and** the expiry together, so a valid signature
cannot be moved onto another object or given a later deadline. Both were tested.

| | |
|---|---|
| Browser links | 12 h, rounded to the hour |
| Links given to fal | 1 h |

Expiries are rounded so the same object yields the *same* URL for everyone for
an hour at a time. Without that, every request mints a unique URL, every unique
URL is a guaranteed cache miss, and private media would be far slower than the
public bucket it replaced — on feeds that render hundreds of tiles.

## The pieces

| File | Role |
|---|---|
| `lib/media-url.ts` | Signs and verifies. `signMediaUrl`, `signPayload`, `keyFromUrl` |
| `lib/api-json.ts` | `jsonPrivate()` — a JSON response with every private URL signed |
| `lib/fal-client.ts` | The fal client, wrapped so job inputs are signed automatically |
| `instrumentation.ts` | Teaches server-side `fetch` to sign our own bucket |
| `workers/media/` | The Cloudflare Worker |
| `lib/r2.ts` | `uploadPublicAsset` (public bucket), `userKey`, `objectExists` |

Three of those exist to make the safe thing automatic, because **a miss is
silent** — a forgotten call site does not error, it just leaves a permanent
public URL in a response:

- **`signPayload` walks the whole payload**, so a URL buried in a JSON metadata
  column or a nested row is covered without anyone remembering it is there.
- **`lib/fal-client.ts` wraps the client rather than installing a fetch.**
  `fal.config()` *replaces* the configuration wholesale, and 20+ routes call
  `fal.config({ credentials })` at module load — a fetch installed once would be
  silently discarded by whichever route imported last.
- **`instrumentation.ts` patches server-side `fetch`** for our bucket only.
  ~140 server call sites did `fetch(row.imageUrl)`; every one would have
  returned 401 and had to be found by hand.

## Environment

```
R2_BUCKET_NAME        # unchanged — now the PRIVATE bucket
R2_PUBLIC_URL         # unchanged — now just the stored-URL prefix, not a working URL
MEDIA_HOST            # NEW  https://prompt-protocol-media.<subdomain>.workers.dev
MEDIA_SIGNING_SECRET  # NEW  32+ random bytes; identical in the app and the Worker
R2_PUBLIC_BUCKET_NAME # NEW  the small public bucket
R2_PUBLIC_ASSET_URL   # NEW  its r2.dev URL
```

Generate the secret with `openssl rand -base64 48`.

## Rollout — order matters

Doing these out of order takes every image on the site down at once.

1. **Create the public bucket**, enable public access on it, set
   `R2_PUBLIC_BUCKET_NAME` / `R2_PUBLIC_ASSET_URL`.
2. **Migrate the public assets** — `node scripts/migrate-public-assets.mjs --dry-run`
   first, then for real. Logo, home cards, carousel. Small: a few dozen files.
3. **Set `MEDIA_HOST` and `MEDIA_SIGNING_SECRET`** in Vercel *and* locally.
4. **Deploy the Worker**: edit `workers/media/wrangler.toml` with the private
   bucket name, then `npx wrangler deploy` and
   `npx wrangler secret put MEDIA_SIGNING_SECRET`.
5. **Deploy the app.** At this point both paths work — the bucket is still
   public, but everything already prefers signed URLs. Verify the site is
   healthy here; this is the last easily reversible step.
6. **Switch off public r2.dev access** on the private bucket in the Cloudflare
   dashboard. This is the moment it becomes private.
7. **Verify**: `node scripts/verify-media-privacy.mjs` — it re-runs the
   unauthenticated fetches that currently return 200 and expects them to fail.

To roll back, re-enable public access in step 6. Nothing was renamed or
deleted, so the old URLs start working again immediately.

## Known gaps

- **Standalone scripts** (`warm-ref-thumbs.mjs` and friends) use bare `fetch`
  and are not covered by `instrumentation.ts`. They must sign, or read through
  the S3 API.
- **User-scoped keys (`u/{id}/…`) apply to new uploads only.** Existing objects
  keep their flat keys. This does not affect security — ownership is in
  Postgres — but a future move to first-party signed cookies (which checks a key
  prefix against the cookie's user id) would need a one-time re-key of the
  older objects.
- **The cookie upgrade needs a custom domain.** `vercel.app` is on the Public
  Suffix List, so a cookie set by the app can never reach a Worker on
  `workers.dev`, and Safari blocks the third-party cookie alternative outright.
  With a custom domain — app on the apex, Worker on `media.` — the cookie
  design becomes available and URLs become session-bound.
- Signed URLs still work if copied, until they expire. That is the trade the
  HMAC design makes; the cookie upgrade above is what closes it.
