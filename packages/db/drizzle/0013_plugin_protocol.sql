-- hy-guard plugin protocol (claude-plugin/docs/BACKEND_CONTRACT.md): devices signed in with a
-- key-bound flow (DPoP), their tokens, browser challenges, known networks and telemetry.
ALTER TABLE `device` ADD `jkt` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `jwk` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `presence_jkt` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `presence_jwk` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `key_storage` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `short_code` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `fingerprint_details` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `context` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `theft_suspected_at` integer;
--> statement-breakpoint
ALTER TABLE `device` ADD `untrusted_at` integer;
--> statement-breakpoint
ALTER TABLE `device` ADD `untrusted_source` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `last_ip` text;
--> statement-breakpoint
ALTER TABLE `device` ADD `last_network_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `device_jkt_uq` ON `device` (`jkt`);
--> statement-breakpoint
ALTER TABLE `mcp_server` ADD `tool_pins` text;
--> statement-breakpoint
CREATE TABLE `plugin_auth_code` (
  `code_hash` text PRIMARY KEY NOT NULL,
  `client_id` text NOT NULL,
  `redirect_uri` text NOT NULL,
  `code_challenge` text NOT NULL,
  `dpop_jkt` text NOT NULL,
  `org_id` text NOT NULL,
  `user_id` text NOT NULL,
  `device_name` text NOT NULL,
  `platform` text,
  `key_storage` text,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plugin_refresh_token` (
  `id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL,
  `org_id` text NOT NULL,
  `user_id` text NOT NULL,
  `device_id` text NOT NULL,
  `jkt` text NOT NULL,
  `expires_at` integer NOT NULL,
  `unlocked_until` integer NOT NULL,
  `revoked_at` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`device_id`) REFERENCES `device`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_refresh_token_token_hash_unique` ON `plugin_refresh_token` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `plugin_refresh_device_idx` ON `plugin_refresh_token` (`device_id`);
--> statement-breakpoint
CREATE TABLE `plugin_challenge` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `device_id` text NOT NULL,
  `user_id` text NOT NULL,
  `tool` text NOT NULL,
  `description` text,
  `tier` text,
  `arguments` text,
  `action_hash` text NOT NULL,
  `reasons` text NOT NULL,
  `device_name` text,
  `device_code` text,
  `key_storage` text,
  `claude_session_id` text,
  `ip` text,
  `country` text,
  `posture_score` integer,
  `status` text DEFAULT 'pending' NOT NULL,
  `approved_by` text,
  `approved_at` integer,
  `expires_at` integer NOT NULL,
  `used_at` integer,
  `event_id` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`device_id`) REFERENCES `device`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plugin_challenge_device_idx` ON `plugin_challenge` (`device_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `device_network` (
  `device_id` text NOT NULL,
  `ip` text NOT NULL,
  `country` text,
  `lat` real,
  `lon` real,
  `first_seen_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL,
  FOREIGN KEY (`device_id`) REFERENCES `device`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_network_uq` ON `device_network` (`device_id`,`ip`);
--> statement-breakpoint
CREATE TABLE `plugin_event` (
  `event_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `device_id` text NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL,
  `source` text,
  `ts` integer NOT NULL,
  `context` text,
  `data` text,
  `received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plugin_event_device_idx` ON `plugin_event` (`device_id`,`ts`);
--> statement-breakpoint
CREATE TABLE `dpop_jti` (
  `jti` text PRIMARY KEY NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dpop_jti_expires_idx` ON `dpop_jti` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `plugin_rejection` (
  `id` text PRIMARY KEY NOT NULL,
  `ip` text,
  `path` text NOT NULL,
  `reason` text NOT NULL,
  `theft_suspected` integer DEFAULT false NOT NULL,
  `victim_device_id` text,
  `presented_jkt` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plugin_rejection_created_idx` ON `plugin_rejection` (`created_at`);
