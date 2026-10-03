CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `approval` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`device_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`reasons` text NOT NULL,
	`trusts_device` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `approval_org_status_idx` ON `approval` (`org_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target` text,
	`data` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_org_created_idx` ON `audit_log` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `cc_session` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text,
	`resource_ids` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`blocked_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cc_session_org_seen_idx` ON `cc_session` (`org_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `device` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`label` text NOT NULL,
	`platform` text,
	`status` text NOT NULL,
	`first_seen_ip` text,
	`first_seen_country` text,
	`approved_by` text,
	`approved_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_user_fp_uq` ON `device` (`user_id`,`fingerprint_hash`);--> statement-breakpoint
CREATE INDEX `device_org_idx` ON `device` (`org_id`);--> statement-breakpoint
CREATE TABLE `device_code` (
	`device_code_hash` text PRIMARY KEY NOT NULL,
	`user_code` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`device_label` text NOT NULL,
	`platform` text,
	`ip` text,
	`country` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`org_id` text,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_userCode_unique` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE TABLE `event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text,
	`session_id` text,
	`kind` text NOT NULL,
	`model` text,
	`mcp_server_id` text,
	`tool_name` text,
	`resource_ids` text NOT NULL,
	`decision` text NOT NULL,
	`checks` text NOT NULL,
	`risk_score` real DEFAULT 0 NOT NULL,
	`workflow_version` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer NOT NULL,
	`upstream_status` integer,
	`ip` text,
	`country` text,
	`user_agent` text,
	`payload_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_id_unique` ON `event` (`id`);--> statement-breakpoint
CREATE INDEX `event_org_created_idx` ON `event` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `event_org_decision_idx` ON `event` (`org_id`,`decision`,`created_at`);--> statement-breakpoint
CREATE INDEX `event_org_user_idx` ON `event` (`org_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `event_session_idx` ON `event` (`session_id`);--> statement-breakpoint
CREATE TABLE `gateway_refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `device`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_refresh_token_tokenHash_unique` ON `gateway_refresh_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `refresh_device_idx` ON `gateway_refresh_token` (`device_id`);--> statement-breakpoint
CREATE TABLE `group` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `group_org_idx` ON `group` (`org_id`);--> statement-breakpoint
CREATE TABLE `group_member` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_member_uq` ON `group_member` (`group_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`inviter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`user_id` text,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text,
	`expires_at` integer,
	`account_label` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_server`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_credential_user_uq` ON `mcp_credential` (`mcp_server_id`,`user_id`) WHERE "mcp_credential"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_credential_org_uq` ON `mcp_credential` (`mcp_server_id`) WHERE "mcp_credential"."user_id" is null;--> statement-breakpoint
CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`preset` text,
	`url` text NOT NULL,
	`auth_type` text NOT NULL,
	`credential_mode` text DEFAULT 'user' NOT NULL,
	`oauth` text,
	`tools` text NOT NULL,
	`tools_refreshed_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_org_slug_uq` ON `mcp_server` (`org_id`,`slug`);--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_org_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_user_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`scope` text NOT NULL,
	`target` text NOT NULL,
	`limit` integer NOT NULL,
	`window_sec` integer NOT NULL,
	`per` text DEFAULT 'user' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limit_org_idx` ON `rate_limit` (`org_id`);--> statement-breakpoint
CREATE TABLE `resource` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`mcp_server_id` text,
	`tool_patterns` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_server`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resource_org_idx` ON `resource` (`org_id`);--> statement-breakpoint
CREATE TABLE `resource_grant` (
	`resource_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resource`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_grant_uq` ON `resource_grant` (`resource_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`active_organization_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_version` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_org_version_uq` ON `workflow_version` (`org_id`,`version`);