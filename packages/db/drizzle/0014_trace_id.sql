-- One trace per user turn. Rows from before this migration keep NULL.
ALTER TABLE `event` ADD `trace_id` text;
--> statement-breakpoint
CREATE INDEX `event_trace_idx` ON `event` (`trace_id`);
