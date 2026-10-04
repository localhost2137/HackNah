-- Workflows are called guardrails everywhere now. Only names change; ids keep their `wf_` prefix.
-- SQLite carries foreign keys and the analysis triggers over to the renamed tables.
ALTER TABLE `workflow` RENAME TO `guardrail`;
--> statement-breakpoint
ALTER TABLE `workflow_version` RENAME TO `guardrail_version`;
--> statement-breakpoint
ALTER TABLE `guardrail_version` RENAME COLUMN `workflow_id` TO `guardrail_id`;
--> statement-breakpoint
ALTER TABLE `event` RENAME COLUMN `workflows` TO `guardrails`;
--> statement-breakpoint
DROP INDEX `workflow_org_idx`;
--> statement-breakpoint
CREATE INDEX `guardrail_org_idx` ON `guardrail` (`org_id`);
--> statement-breakpoint
DROP INDEX `workflow_version_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `guardrail_version_uq` ON `guardrail_version` (`guardrail_id`,`version`);
--> statement-breakpoint
-- Limits that hand the decision to a guardrail, and limits on what guardrails spend on judges.
UPDATE `rate_limit` SET `action` = 'guardrail' WHERE `action` = 'workflow';
--> statement-breakpoint
UPDATE `rate_limit` SET `scope` = 'guardrails' WHERE `scope` = 'workflows';
