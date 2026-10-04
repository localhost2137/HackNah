interface AppSecrets {
  OPENROUTER_API_KEY: string
  JWT_SECRET: string
  BETTER_AUTH_SECRET: string
  ENCRYPTION_KEY: string
  /** Bearer token for a self-hosted judge endpoint. OpenRouter judges use `OPENROUTER_API_KEY`. */
  JUDGE_API_KEY?: string
  /** Comma-separated URLs of signature feeds from an externally managed system. */
  SIGNATURE_FEED_URL?: string
}

interface Env extends AppSecrets {}

declare namespace Cloudflare {
  interface Env extends AppSecrets {}
}
