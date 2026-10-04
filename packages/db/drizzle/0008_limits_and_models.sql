-- Rate limits become Limits: besides requests they count concurrency, tokens, USD and GPU time,
-- per user, per member of a group, for a group in total or for the org. Existing rules keep
-- counting requests and blocking, as before.
ALTER TABLE `rate_limit` ADD `name` text DEFAULT '' NOT NULL;
ALTER TABLE `rate_limit` ADD `measure` text DEFAULT 'requests' NOT NULL;
ALTER TABLE `rate_limit` ADD `group_id` text;
ALTER TABLE `rate_limit` ADD `action` text DEFAULT 'block' NOT NULL;
ALTER TABLE `rate_limit` ADD `warn_at_pct` integer DEFAULT 80 NOT NULL;

-- Model catalog. While it is empty every model goes to the default upstream, at no cost.
CREATE TABLE `model` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`pattern` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'external' NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`upstream_model` text DEFAULT '' NOT NULL,
	`api_key_enc` text,
	`input_usd_per_m_tok` real DEFAULT 0 NOT NULL,
	`output_usd_per_m_tok` real DEFAULT 0 NOT NULL,
	`cache_write_usd_per_m_tok` real DEFAULT 0 NOT NULL,
	`cache_read_usd_per_m_tok` real DEFAULT 0 NOT NULL,
	`gpu_usd_per_hour` real DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX `model_org_idx` ON `model` (`org_id`);

-- Usage and timing per event.
ALTER TABLE `event` ADD `cache_read_tokens` integer;
ALTER TABLE `event` ADD `cache_write_tokens` integer;
ALTER TABLE `event` ADD `cost_usd` real;
ALTER TABLE `event` ADD `gpu_ms` integer;
ALTER TABLE `event` ADD `overhead_ms` integer;
