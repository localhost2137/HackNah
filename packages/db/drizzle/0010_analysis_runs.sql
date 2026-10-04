-- Persist replay results separately from production gateway events.
CREATE TABLE analysis_revision (
  org_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE analysis_run (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  catalog_version TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  total INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  payload_key TEXT NOT NULL
);
CREATE INDEX analysis_run_scope_idx ON analysis_run (org_id, revision, catalog_version, created_at);

-- Increment in the same transaction as the rule write, including direct SQL and rollbacks.
CREATE TRIGGER analysis_workflow_insert AFTER INSERT ON `workflow`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_workflow_update AFTER UPDATE ON `workflow`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_workflow_delete AFTER DELETE ON `workflow`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (OLD.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_workflow_version_insert AFTER INSERT ON `workflow_version`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_workflow_version_update AFTER UPDATE ON `workflow_version`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_workflow_version_delete AFTER DELETE ON `workflow_version`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (OLD.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_rate_limit_insert AFTER INSERT ON `rate_limit`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_rate_limit_update AFTER UPDATE ON `rate_limit`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_rate_limit_delete AFTER DELETE ON `rate_limit`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (OLD.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_group_insert AFTER INSERT ON `group`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_group_update AFTER UPDATE ON `group`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_group_delete AFTER DELETE ON `group`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (OLD.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_resource_insert AFTER INSERT ON `resource`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_resource_update AFTER UPDATE ON `resource`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_resource_delete AFTER DELETE ON `resource`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (OLD.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_mcp_server_insert AFTER INSERT ON `mcp_server`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_mcp_server_update AFTER UPDATE ON `mcp_server` WHEN OLD.name IS NOT NEW.name OR OLD.slug IS NOT NEW.slug OR OLD.url IS NOT NEW.url OR OLD.enabled IS NOT NEW.enabled OR OLD.tools IS NOT NEW.tools OR OLD.credential_mode IS NOT NEW.credential_mode OR OLD.auth_type IS NOT NEW.auth_type
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_mcp_server_delete AFTER DELETE ON `mcp_server`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (OLD.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_group_member_insert AFTER INSERT ON `group_member`
BEGIN
  INSERT INTO analysis_revision (org_id, revision)
  SELECT org_id, 1 FROM `group` WHERE id = NEW.group_id
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_group_member_update AFTER UPDATE ON `group_member`
BEGIN
  INSERT INTO analysis_revision (org_id, revision)
  SELECT org_id, 1 FROM `group` WHERE id = NEW.group_id
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_group_member_delete AFTER DELETE ON `group_member`
BEGIN
  INSERT INTO analysis_revision (org_id, revision)
  SELECT org_id, 1 FROM `group` WHERE id = OLD.group_id
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_resource_grant_insert AFTER INSERT ON `resource_grant`
BEGIN
  INSERT INTO analysis_revision (org_id, revision)
  SELECT org_id, 1 FROM `resource` WHERE id = NEW.resource_id
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_resource_grant_update AFTER UPDATE ON `resource_grant`
BEGIN
  INSERT INTO analysis_revision (org_id, revision)
  SELECT org_id, 1 FROM `resource` WHERE id = NEW.resource_id
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_resource_grant_delete AFTER DELETE ON `resource_grant`
BEGIN
  INSERT INTO analysis_revision (org_id, revision)
  SELECT org_id, 1 FROM `resource` WHERE id = OLD.resource_id
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_model_insert AFTER INSERT ON `model`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_model_update AFTER UPDATE ON `model`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (NEW.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER analysis_model_delete AFTER DELETE ON `model`
BEGIN
  INSERT INTO analysis_revision (org_id, revision) VALUES (OLD.org_id, 1)
  ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1;
END;
