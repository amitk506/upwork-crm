import { z } from 'zod'

/**
 * Fail fast and loudly on misconfiguration.
 *
 * Split deliberately: `clientEnv` is safe to reach the browser, `serverEnv`
 * must never be imported from a client component. The service-role key and the
 * token encryption key in particular would be catastrophic to ship in a bundle.
 */

/**
 * Treat an empty string as absent. Docker compose turns an unset variable into
 * `FOO=`, which zod sees as a present empty string rather than undefined.
 */
function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional())
}

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
  // Shown under the wordmark and in page titles. Nothing else depends on it.
  NEXT_PUBLIC_AGENCY_NAME: z.string().min(1).default('Your Agency'),
})

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // 32 bytes, base64. Generate with:  openssl rand -base64 32
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'TOKEN_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)',
    ),

  // Upwork OAuth. Obtained instantly via dynamic client registration —
  // see docs/01-research-findings.md §5 and scripts/register-oauth-client.mjs
  // `optional()` alone is not enough here: docker compose passes unset values
  // through as EMPTY STRINGS, which are present-but-too-short and fail .min(1).
  // Normalise "" to undefined first so an unset variable behaves like one.
  UPWORK_CLIENT_ID: emptyToUndefined(z.string().min(1)),
  UPWORK_CLIENT_SECRET: emptyToUndefined(z.string().min(1)),
  UPWORK_ORG_UID: emptyToUndefined(z.string().min(1)),

  // Shared secret for the unattended sync tick. The cron container presents it
  // as x-sync-key; without it /api/sync refuses to run at all.
  SYNC_SECRET: emptyToUndefined(z.string().min(16)),

  // Secret path segment for the read-only status board at /status/<token>.
  //
  // Optional on purpose: unset means the board simply does not exist, which is
  // the right default for a page that answers without a login. 24 characters
  // minimum because the URL IS the credential — anyone holding it sees which
  // clients are waiting, so it has to be long enough not to be guessed or
  // stumbled upon.
  STATUS_BOARD_TOKEN: emptyToUndefined(z.string().min(24)),

  // The WhatsApp portal's read-only waiting feed, so the board can show both
  // channels in one place. Both optional: unset simply means the board shows
  // Upwork only, which is what it did before and a perfectly good fallback if
  // that host is ever down.
  WHATSAPP_FEED_URL: emptyToUndefined(z.string().url()),
  WHATSAPP_FEED_TOKEN: emptyToUndefined(z.string().min(24)),

  // Where the end-of-day check reads the company's holiday list from. Optional:
  // unset means the nightly reply check is skipped entirely rather than run
  // without knowing which days were working days. Expected to return a JSON
  // array of { date: 'yyyy-mm-dd', name, type } for ?year=YYYY.
  HOLIDAYS_URL: emptyToUndefined(z.string().url()),

  // The redirect URI registered with Upwork. Until an approved API key allows a
  // real HTTPS callback, this is a LOOPBACK address that nothing serves — the
  // user pastes the resulting code back into /connect. It must match the
  // registration byte for byte, at both authorize and token-exchange time.
  UPWORK_REDIRECT_URI: emptyToUndefined(z.url()).pipe(
    z.string().default('http://localhost:3000/api/upwork/callback'),
  ),
})

export const clientEnv = clientSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_AGENCY_NAME: process.env.NEXT_PUBLIC_AGENCY_NAME,
})

let cachedServerEnv: z.infer<typeof serverSchema> | null = null

/**
 * Lazy so that importing this module from a client component does not blow up
 * at build time — it only throws if server-only config is actually read.
 */
export function serverEnv() {
  if (!cachedServerEnv) {
    cachedServerEnv = serverSchema.parse({
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
      UPWORK_CLIENT_ID: process.env.UPWORK_CLIENT_ID,
      UPWORK_CLIENT_SECRET: process.env.UPWORK_CLIENT_SECRET,
      UPWORK_ORG_UID: process.env.UPWORK_ORG_UID,
      UPWORK_REDIRECT_URI: process.env.UPWORK_REDIRECT_URI,
      SYNC_SECRET: process.env.SYNC_SECRET,
      STATUS_BOARD_TOKEN: process.env.STATUS_BOARD_TOKEN,
      WHATSAPP_FEED_URL: process.env.WHATSAPP_FEED_URL,
      WHATSAPP_FEED_TOKEN: process.env.WHATSAPP_FEED_TOKEN,
      HOLIDAYS_URL: process.env.HOLIDAYS_URL,
    })
  }
  return cachedServerEnv
}
