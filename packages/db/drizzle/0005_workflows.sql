-- Several named workflows instead of one. The existing workflow becomes "Default", which runs for
-- every member and every request, so behaviour is unchanged until an admin narrows or disables it.
CREATE TABLE `workflow` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`group_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX `workflow_org_idx` ON `workflow` (`org_id`);

INSERT INTO `workflow` (id, org_id, name, description, enabled, position, group_ids, created_at, updated_at)
SELECT 'wf_default', id, 'Default', 'Runs for every member and every request.', 1, 0, '[]',
  unixepoch() * 1000, unixepoch() * 1000
FROM organization;

-- Versions now belong to a workflow. SQLite can't add a required foreign key in place.
CREATE TABLE `workflow_version_new` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`workflow_id` text NOT NULL REFERENCES `workflow`(`id`) ON DELETE cascade,
	`version` integer NOT NULL,
	`definition` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
INSERT INTO `workflow_version_new`
SELECT id, org_id, 'wf_default', version, definition, status, note, created_by, created_at
FROM `workflow_version`;
DROP TABLE `workflow_version`;
ALTER TABLE `workflow_version_new` RENAME TO `workflow_version`;
CREATE UNIQUE INDEX `workflow_version_uq` ON `workflow_version` (`workflow_id`,`version`);

-- An unpublished workflow no longer falls back to the built-in graph; publish it explicitly.
INSERT INTO `workflow_version` (id, org_id, workflow_id, version, definition, status, note, created_by, created_at)
SELECT 'wfv_builtin', w.org_id, w.id,
  CASE WHEN EXISTS (SELECT 1 FROM `workflow_version` v WHERE v.workflow_id = w.id)
    THEN (SELECT min(version) - 1 FROM `workflow_version` v WHERE v.workflow_id = w.id)
    ELSE 1 END,
  '{"nodes":[{"id":"start","position":{"x":0,"y":100},"type":"trigger","mode":"all","conditions":[]},{"id":"fingerprint","position":{"x":320,"y":100},"type":"check","enabled":true,"check":{"type":"fingerprint"}},{"id":"keywords","position":{"x":660,"y":0},"type":"check","enabled":true,"check":{"type":"keywords","patterns":["rm -rf /","DROP DATABASE","curl * | sh","aws_secret_access_key"],"mode":"substring","caseSensitive":false}},{"id":"allow","position":{"x":1000,"y":0},"type":"decision","action":"allow","method":"admin","timeoutSec":300,"reason":""},{"id":"approve","position":{"x":660,"y":340},"type":"decision","action":"require_approval","method":"admin","timeoutSec":300,"reason":"Request from a new device"},{"id":"block","position":{"x":1000,"y":220},"type":"decision","action":"block","method":"admin","timeoutSec":300,"reason":""}],"edges":[{"id":"e1","source":"start","sourceHandle":"next","target":"fingerprint"},{"id":"e2","source":"fingerprint","sourceHandle":"pass","target":"keywords"},{"id":"e3","source":"fingerprint","sourceHandle":"new","target":"approve"},{"id":"e4","source":"fingerprint","sourceHandle":"mismatch","target":"block"},{"id":"e5","source":"keywords","sourceHandle":"pass","target":"allow"},{"id":"e6","source":"keywords","sourceHandle":"fail","target":"block"}],"fallback":"block"}',
  'published', 'Built-in default', NULL, unixepoch() * 1000
FROM `workflow` w
WHERE NOT EXISTS (
  SELECT 1 FROM `workflow_version` v WHERE v.workflow_id = w.id AND v.status = 'published'
);

-- Events record every workflow that ran instead of one version number.
ALTER TABLE `event` ADD `workflows` text DEFAULT '[]' NOT NULL;
UPDATE `event`
SET workflows = json_array(json_object('id', 'wf_default', 'name', 'Default', 'version', workflow_version))
WHERE workflow_version IS NOT NULL;
ALTER TABLE `event` DROP COLUMN `workflow_version`;
