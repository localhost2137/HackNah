/** Headers sent by the Claude Code plugin to the gateway. */
export const HEADER_SESSION_ID = 'x-acl-session-id'
export const HEADER_DEVICE_FINGERPRINT = 'x-acl-device'
export const HEADER_RESOURCES = 'x-acl-resources'

/** Claude Code's own session header, used when the plugin header is absent. */
export const HEADER_CC_SESSION_ID = 'x-claude-code-session-id'
