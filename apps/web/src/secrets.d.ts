interface AppSecrets {
  OPENROUTER_API_KEY: string
  JWT_SECRET: string
  BETTER_AUTH_SECRET: string
  ENCRYPTION_KEY: string
  /** Bearer token for a self-hosted judge endpoint. OpenRouter judges use `OPENROUTER_API_KEY`. */
  JUDGE_API_KEY?: string
  /** Comma-separated URLs of signature feeds from an externally managed system. */
  SIGNATURE_FEED_URL?: string
  /**
   * Private ES256 JWK (JSON) that signs responses to the hy-guard plugin. Plugins pin its public
   * half on first contact, so it has to stay the same. Without it the plugin protocol is off.
   */
  RESPONSE_SIGNING_JWK?: string
}

interface Env extends AppSecrets {}

declare namespace Cloudflare {
  interface Env extends AppSecrets {}
}
