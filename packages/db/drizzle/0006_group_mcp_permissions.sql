-- Groups can see MCP servers and tools directly, keyed by server id. Nothing changes for existing
-- groups: their MCP access keeps coming from resource grants only.
UPDATE `group` SET permissions = json_set(permissions, '$.mcp', json('{}'))
WHERE json_type(permissions, '$.mcp') IS NULL;
