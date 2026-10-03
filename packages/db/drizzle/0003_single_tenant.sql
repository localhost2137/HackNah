-- Keep existing policy/log foreign keys, but enforce exactly one instance scope.
-- If an old installation has multiple tenants, this fails instead of silently merging data.
CREATE UNIQUE INDEX organization_singleton ON organization ((1));
INSERT INTO organization (id, name, slug, created_at)
SELECT 'instance', 'Instance', 'instance', unixepoch() * 1000
WHERE NOT EXISTS (SELECT 1 FROM organization);

-- An atomic first-account bootstrap; subsequent signups need admin-granted access or SSO.
CREATE TRIGGER bootstrap_instance_admin AFTER INSERT ON user
WHEN (SELECT count(*) FROM user) = 1 AND NOT EXISTS (SELECT 1 FROM member)
BEGIN
  INSERT INTO member (id, organization_id, user_id, role, created_at)
  SELECT 'bootstrap-' || NEW.id, id, NEW.id, 'admin', NEW.created_at FROM organization;
END;
