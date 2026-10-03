-- Groups carry permissions; every member implicitly belongs to the instance's default group.
ALTER TABLE `group` ADD `is_default` integer DEFAULT false NOT NULL;
ALTER TABLE `group` ADD `permissions` text DEFAULT '{"models":[],"builtinTools":[]}' NOT NULL;
CREATE UNIQUE INDEX `group_org_default_uq` ON `group` (`org_id`) WHERE `is_default` = 1;

-- Existing members keep every model and built-in tool they could use before.
INSERT INTO `group` (id, org_id, name, description, is_default, permissions, created_at)
SELECT 'grp_default', id, 'Everyone', 'All members of the instance.', 1,
  '{"models":["*"],"builtinTools":["*"]}', unixepoch() * 1000
FROM organization
WHERE NOT EXISTS (SELECT 1 FROM `group` WHERE is_default = 1);
