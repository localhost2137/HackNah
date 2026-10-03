// Wire types between the plugin bridge and the platform backend.
// Documentation for backend developers; the bridge itself is plain JS.
// Spec: docs/BACKEND_CONTRACT.md

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  gateway_url: string;
  policy_endpoint: string;
  events_endpoint: string;
  challenges_endpoint: string;
  /** Base URL of the model gateway; the local proxy appends Claude Code's path (/v1/messages, ...) */
  llm_gateway_url?: string;
  /** Public key for HY-Response-Signature; pinned by the bridge on first contact */
  response_signing_jwk?: EcPublicJwk & { alg: 'ES256'; use: 'sig'; kid: string };
  dpop_signing_alg_values_supported: ['ES256'];
}

export type KeyStorage = 'secure_enclave' | 'software' | 'tpm';

/** Query params of GET /authorize */
export interface AuthorizeRequest {
  response_type: 'code';
  client_id: 'hy-cc-plugin';
  redirect_uri: string; // http://127.0.0.1:<port>/callback
  state: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  dpop_jkt: string; // RFC 7638 thumbprint of the routine key
  device_name: string;
  key_storage: KeyStorage;
  platform: 'darwin' | 'linux' | 'win32' | string;
}

/** Form body of POST /token */
export type TokenRequest =
  | {
      grant_type: 'authorization_code';
      code: string;
      code_verifier: string;
      redirect_uri: string;
      client_id: string;
      presence_jwk?: string; // JSON.stringify(EcPublicJwk)
      device_fingerprint?: string; // JSON.stringify(DeviceFingerprint)
    }
  | { grant_type: 'refresh_token'; refresh_token: string; client_id: string };

export interface TokenResponse {
  access_token: string;
  token_type: 'DPoP';
  expires_in: number;
  unlock_expires_in: number; // after this, refresh needs a presence proof (Touch ID)
  refresh_token: string;
  user: { id: string; email: string; name: string };
  device: { id: string; short_code: string; key_storage: KeyStorage };
}

export interface OAuthError {
  error: 'invalid_grant' | 'invalid_dpop_proof' | 'use_dpop_nonce' | 'unsupported_grant_type' | 'invalid_token';
  error_description?: string;
}

export interface EcPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** JWS header of the DPoP header */
export interface DpopHeader {
  typ: 'dpop+jwt';
  alg: 'ES256';
  jwk: EcPublicJwk;
}

/** JWS payload of DPoP and HY-Presence-Proof (identical claims) */
export interface DpopClaims {
  jti: string;
  htm: string;
  htu: string; // scheme://host/path
  iat: number;
  nonce?: string;
  ath?: string; // b64url(sha256(access_token))
  bh?: string; // b64url(sha256(body)), platform extension
  dfp?: string; // b64url(sha256(canonical JSON of DeviceFingerprint))
  ctxh?: string; // b64url(sha256(decoded HY-Client-Context JSON))
  idle?: number; // seconds since last keyboard/mouse input (macOS)
  hook?: { sid: string; eid: string; ah: string; ts: number }; // Claude Code PreToolUse record for this tools/call
  ztah?: string; // b64url(sha256(HY-Posture-ZTA header)), CrowdStrike ZTA token
  osp?: { fv: boolean | null; sip: boolean | null; gk: boolean | null; fw: boolean | null }; // FileVault, SIP, Gatekeeper, firewall
}

/** Stable facts, sent once at sign-in (token request `device_fingerprint`), then only as `dfp`. */
export interface DeviceFingerprint {
  machine_id_hash: string | null; // sha256("hy-guard-machine:" + IOPlatformUUID | /etc/machine-id | MachineGuid)
  hardware_model: string | null;
  cpu_model: string | null;
  cpu_count: number;
  memory_gb: number;
  os_family: string;
  arch: string;
}

/** HY-Client-Context header (base64url JSON) on every request, bound by `ctxh`. */
export interface ClientContext {
  os_version: string;
  kernel: string;
  hostname: string;
  os_user: string;
  node: string;
  bridge: string;
  key_storage: KeyStorage;
  client: { name: string; version: string } | null; // Claude Code
}

export type ToolAction = 'allow' | 'ask' | 'deny' | 'hide';
export type ToolTier = 'read' | 'write' | 'destructive';
export type Approval = 'none' | 'confirm' | 'touchid' | 'browser';

export interface Policy {
  version: string;
  refresh_seconds: number;
  default_action: ToolAction;
  tools: { match: string; action?: ToolAction; tier?: ToolTier; approval?: Approval; untrusted_source?: boolean }[];
  /** Prompt-injection guard: what counts as untrusted input, and for how long it taints the session */
  untrusted_content?: { builtin_sources: string[]; window_minutes: number };
  approval_defaults?: Partial<Record<ToolTier, Approval>>;
  argument_rules: { tool: string; argument: string; pattern: string; message?: string }[];
  pinning: 'enforce' | 'warn' | 'off';
  pinned: Record<string, string>; // tool name -> definition hash
  telemetry: { flush_seconds: number };
}

/** JSON-RPC error data for tools/call trust decisions */
export const ERR_CHALLENGE = -32010;
export const ERR_DENIED = -32011;

export interface ChallengeErrorData {
  decision_id: string;
  challenge: { id: string; approve_url: string; expires_in: number; reasons: string[] };
}

export interface DeniedErrorData {
  decision_id: string;
  reasons: string[];
}

export interface ChallengeStatus {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expires_at: string;
}

export type EventType =
  | 'bridge_started'
  | 'signed_in'
  | 'signed_out'
  | 'tools_listed'
  | 'tool_call'
  | 'tool_blocked_locally'
  | 'tool_definition_changed'
  | 'challenge_shown'
  | 'session_start'
  | 'pre_tool_use';

export interface PlatformEvent {
  event_id: string;
  type: EventType;
  ts: string;
  source: 'bridge' | 'hook';
  context: {
    // bridge events
    instance_id?: string;
    device_jkt?: string;
    key_storage?: KeyStorage;
    os?: string;
    bridge_version?: string;
    project?: string;
    client?: { name: string; version: string } | null;
    // hook events
    claude_session_id?: string;
    cwd?: string;
  };
  data: Record<string, unknown>;
}

/** Input to the trust decision for one tools/call */
export interface TrustSignals {
  tool: string;
  tier: ToolTier;
  org_action: ToolAction;
  presence_verified: boolean;
  key_storage: KeyStorage;
  ip: string;
  ip_known: boolean;
  geo: { country: string; city?: string; lat: number; lon: number; datacenter?: boolean } | null;
  travel_kmh: number | null;
  untrusted_content_minutes_ago: number | null;
  untrusted_source: string | null; // what was read: "example.com (WebFetch)", "email_read_inbox"
  untrusted_window_minutes: number;
  approved_challenge: boolean;
  approval: Approval;
  presence_capable: boolean;
  hook_correlated: boolean;
  claude_session_id: string | null;
  session_known: boolean;
  user_idle_minutes: number | null;
  posture_status: 'ok' | 'stale' | 'missing' | 'invalid' | 'unknown' | 'compromised';
  posture_score: number | null; // lower of the device's ZTA token and the Falcon cloud score
  os_posture: { fv: boolean | null; sip: boolean | null; gk: boolean | null; fw: boolean | null } | null;
  posture_reason: string | null;
  // later: ml_session_risk, ai_session_risk, ai_verdict, ...
}

export interface TrustDecision {
  decision: 'allow' | 'challenge' | 'deny';
  reasons: string[];
}

/** Pushed security event (OpenID CAEP), POST /v1/signals/caep */
export interface CaepDeviceComplianceChange {
  iss: string;
  jti: string;
  iat: number;
  events: {
    'https://schemas.openid.net/secevent/caep/event-type/device-compliance-change': {
      subject: { format: 'opaque'; id: string }; // CrowdStrike agent ID or platform device ID
      current_status: 'compliant' | 'not-compliant';
      previous_status?: 'compliant' | 'not-compliant';
      reason_admin?: { en: string };
      event_timestamp: number;
    };
  };
}

/** Payload of the HY-Response-Signature JWS (header: alg ES256, kid, typ "hy-response+jwt") */
export interface ResponseSignatureClaims {
  jti: string; // the request's DPoP proof jti
  status: number;
  bh: string; // b64url(sha256(raw response body))
  iat: number;
}
