export type McpPreset = {
  id: string
  name: string
  slug: string
  url: string
  authType: 'none' | 'bearer' | 'oauth2'
  credentialMode: 'org' | 'user'
  oauth?: { authorizeUrl: string; tokenUrl: string; scopes: string[] }
  help: string
}

/**
 * Starting points for common remote MCP servers. Everything stays editable: endpoints change,
 * and OAuth needs an app registered with the provider whose callback is
 * `<dashboard>/api/oauth/callback`.
 */
export const mcpPresets: McpPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    slug: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    authType: 'oauth2',
    credentialMode: 'user',
    oauth: {
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:org'],
    },
    help: 'Create a GitHub OAuth App (Settings → Developer settings) and paste its client id and secret. Each user connects their own account.',
  },
  {
    id: 'atlassian',
    name: 'Jira / Confluence',
    slug: 'jira',
    url: 'https://mcp.atlassian.com/v1/mcp',
    authType: 'oauth2',
    credentialMode: 'user',
    oauth: {
      authorizeUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      scopes: [
        'read:jira-work',
        'write:jira-work',
        'read:confluence-content.all',
        'offline_access',
      ],
    },
    help: 'Register an OAuth 2.0 (3LO) app in the Atlassian developer console.',
  },
  {
    id: 'linear',
    name: 'Linear',
    slug: 'linear',
    url: 'https://mcp.linear.app/mcp',
    authType: 'bearer',
    credentialMode: 'user',
    help: 'Each user pastes a personal API key from Linear settings.',
  },
  {
    id: 'custom',
    name: 'Custom MCP server',
    slug: 'custom',
    url: 'https://',
    authType: 'bearer',
    credentialMode: 'org',
    help: 'Any MCP server reachable over Streamable HTTP.',
  },
]
