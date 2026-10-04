-- A resource is a named bundle of MCP tools that can span several servers: `tools` maps a server
-- id (or `*` for every server) to tool name patterns. It replaces the single `mcp_server_id` with
-- `tool_patterns`, and the MCP section of group permissions: groups get MCP tools through resource
-- grants only.
ALTER TABLE `resource` ADD `tools` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
UPDATE `resource`
SET `tools` = json_object(
  `mcp_server_id`,
  CASE WHEN json_array_length(`tool_patterns`) = 0 THEN json_array('*') ELSE json(`tool_patterns`) END
)
WHERE `mcp_server_id` IS NOT NULL;
--> statement-breakpoint
-- The old column cascades deletes from one server; a bundle must outlive any single server.
UPDATE `resource` SET `mcp_server_id` = NULL, `tool_patterns` = '[]';
--> statement-breakpoint
-- What a group could reach through its own MCP permissions becomes a resource granted to it.
INSERT INTO `resource` (`id`, `org_id`, `name`, `description`, `tool_patterns`, `tools`, `created_at`)
SELECT
  'res_grp_' || `id`,
  `org_id`,
  `name` || ' tools',
  'Converted from the MCP permissions this group had.',
  '[]',
  json_extract(`permissions`, '$.mcp'),
  CAST(unixepoch() AS INTEGER) * 1000
FROM `group`
WHERE json_type(`permissions`, '$.mcp') = 'object' AND json_extract(`permissions`, '$.mcp') <> '{}';
--> statement-breakpoint
INSERT INTO `resource_grant` (`resource_id`, `subject_type`, `subject_id`, `created_at`)
SELECT 'res_grp_' || `id`, 'group', `id`, CAST(unixepoch() AS INTEGER) * 1000
FROM `group`
WHERE json_type(`permissions`, '$.mcp') = 'object' AND json_extract(`permissions`, '$.mcp') <> '{}';
--> statement-breakpoint
UPDATE `group` SET `permissions` = json_remove(`permissions`, '$.mcp');
