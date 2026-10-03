CREATE TABLE `sso_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`issuer` text NOT NULL,
	`domain` text NOT NULL,
	`oidc_config` text,
	`saml_config` text,
	`user_id` text,
	`organization_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_provider_providerId_unique` ON `sso_provider` (`provider_id`);--> statement-breakpoint
CREATE INDEX `sso_provider_org_idx` ON `sso_provider` (`organization_id`);