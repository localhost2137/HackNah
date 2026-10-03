// Mock trust rules for tool calls. This is the part the real trust engine
// (rules + ML + AI analyst) replaces. Keep the input/output shape: the gateway
// only needs { decision, reasons }.
//
// signals (built in server.mjs):
//   tool, tier                      read | write | destructive
//   org_action                      allow | ask | deny | hide (from policy.json)
//   presence_verified               Touch ID proof valid for this request
//   key_storage                     secure_enclave | software
//   ip, ip_known                    ip seen before for this device
//   travel_kmh                      speed implied by the last request location (null if unknown)
//   untrusted_content_minutes_ago   minutes since the session read untrusted content (null if never)
//   untrusted_source                what it read: "example.com (WebFetch)", "email_read_inbox", ...
//   untrusted_window_minutes        policy.untrusted_content.window_minutes (default 10)
//   approved_challenge              the user approved this exact action in the browser
//   hook_correlated                 Claude Code's PreToolUse hook recorded this exact call
//   claude_session_id               Claude Code session from that hook record
//   user_idle_minutes               keyboard/mouse idle time on the device (null if unknown)
//   approval                        none | confirm | touchid | browser (policy approval level)
//   argument_violation              message of a violated argument rule, or null
//   definition_changed              tool's definition differs from the admin-pinned hash
//   presence_capable                device has a registered Touch ID key
//   posture_status, posture_score   CrowdStrike: ok | stale | missing | invalid | unknown | compromised,
//                                   score = lower of the device's ZTA token and the Falcon cloud
//   os_posture                      built-in checks {fv: FileVault, sip: SIP, gk: Gatekeeper, fw: firewall}

const IMPOSSIBLE_TRAVEL_KMH = 900;
const UNTRUSTED_WINDOW_MIN = 10;
const IDLE_LIMIT_MIN = Number(process.env.MOCK_IDLE_MINUTES ?? 30);
// EDR posture thresholds (CrowdStrike ZTA overall score)
export const POSTURE_FLOOR = Number(process.env.ZTA_MIN_ANY ?? 20); // below: nothing allowed
const POSTURE_MIN_WRITE = Number(process.env.ZTA_MIN_WRITE ?? 50); // below: no write/destructive
const POSTURE_REQUIRED = process.env.ZTA_REQUIRED === '1'; // no posture: challenge writes

export function evaluate(s) {
  if (s.org_action === 'hide' || s.org_action === 'deny')
    return { decision: 'deny', reasons: [`blocked by org policy (${s.org_action})`] };
  if (s.argument_violation) return { decision: 'deny', reasons: [`argument rule: ${s.argument_violation}`] };
  if (s.definition_changed) return { decision: 'deny', reasons: ['tool definition changed since an admin pinned it (possible tool poisoning)'] };

  // Posture first: a user approval can't make a compromised laptop safe.
  if (s.posture_status === 'compromised') return { decision: 'deny', reasons: [s.posture_reason] };
  if (s.posture_status === 'invalid') return { decision: 'deny', reasons: [`EDR posture invalid: ${s.posture_reason}`] };
  if (s.posture_score !== null && s.posture_score < POSTURE_FLOOR)
    return { decision: 'deny', reasons: [`CrowdStrike posture score ${s.posture_score} is below ${POSTURE_FLOOR}`] };
  if (s.tier !== 'read' && s.posture_score !== null && s.posture_score < POSTURE_MIN_WRITE)
    return { decision: 'deny', reasons: [`CrowdStrike posture score ${s.posture_score}: ${s.tier} tools need ${POSTURE_MIN_WRITE}+`] };
  // Built-in OS posture (client-reported baseline for devices without an EDR)
  const osp = s.os_posture ?? {};
  if (s.tier !== 'read' && osp.fv === false) return { decision: 'deny', reasons: [`FileVault (disk encryption) is off: ${s.tier} tools are blocked`] };
  if (s.tier !== 'read' && osp.sip === false) return { decision: 'deny', reasons: [`System Integrity Protection is off: ${s.tier} tools are blocked`] };

  if (s.approved_challenge) return { decision: 'allow', reasons: ['user approved this action in the browser (fresh sign-in)'] };

  // Approval levels from policy (server-enforced ones: touchid, browser)
  if (s.approval === 'touchid' && !s.presence_verified && s.presence_capable)
    return { decision: 'deny', reasons: ['this tool needs Touch ID, and the request carried no Touch ID proof'] };
  const reasons = [];
  if (s.approval === 'browser') reasons.push('company policy: approve in the browser with a fresh sign-in');
  if (s.approval === 'touchid' && !s.presence_verified && !s.presence_capable)
    reasons.push('this tool needs Touch ID; this device has none, so approve in the browser');
  const untrustedWindow = s.untrusted_window_minutes ?? UNTRUSTED_WINDOW_MIN;
  if (s.tier !== 'read' && s.untrusted_content_minutes_ago !== null && s.untrusted_content_minutes_ago < untrustedWindow)
    reasons.push(
      `possible prompt injection: the session read untrusted content${s.untrusted_source ? ` (${s.untrusted_source})` : ''} ${s.untrusted_content_minutes_ago} min ago`,
    );
  if (s.tier !== 'read' && !s.ip_known) reasons.push(`first ${s.tier} request from network ${s.ip}`);
  if (s.tier !== 'read' && !s.hook_correlated)
    reasons.push('tool call not started by Claude Code (no matching hook record)');
  if (s.tier !== 'read' && s.user_idle_minutes !== null && s.user_idle_minutes >= IDLE_LIMIT_MIN)
    reasons.push(`user idle for ${s.user_idle_minutes} min`);
  if (s.tier !== 'read' && s.posture_status === 'stale') reasons.push('CrowdStrike posture is outdated');
  if (s.tier !== 'read' && s.posture_status === 'unknown') reasons.push(`EDR posture could not be confirmed: ${s.posture_reason}`);
  if (s.tier !== 'read' && osp.gk === false) reasons.push('Gatekeeper is off');
  if (s.tier !== 'read' && s.posture_status === 'missing' && POSTURE_REQUIRED) reasons.push('no EDR posture from this device');
  if (s.travel_kmh !== null && s.travel_kmh > IMPOSSIBLE_TRAVEL_KMH)
    reasons.push(`impossible travel: ${Math.round(s.travel_kmh)} km/h since the previous request`);

  if (reasons.length) return { decision: 'challenge', reasons };
  return {
    decision: 'allow',
    reasons: s.presence_verified ? ['Touch ID verified'] : ['no risk signals'],
  };
}

// Demo geolocation. Requests carry the real socket IP; with MOCK_TRUST_IP_HEADER=1
// the X-Mock-Client-IP header overrides it (simulate a VPS abroad).
export const MOCK_GEO = {
  '127.0.0.1': { country: 'PL', city: 'Kraków', lat: 50.06, lon: 19.94 },
  '::1': { country: 'PL', city: 'Kraków', lat: 50.06, lon: 19.94 },
  '203.0.113.7': { country: 'SG', city: 'Singapore', lat: 1.35, lon: 103.82, datacenter: true },
  '198.51.100.20': { country: 'US', city: 'Ashburn', lat: 39.04, lon: -77.49, datacenter: true },
};
