-- For scripts/e2e-backend.mjs against a LOCAL database of apps/web: a guardrail that asks the
-- person at the device to approve jira__create_issue in the browser. An admin would build the
-- same in the dashboard: Tool call -> Tool is jira__create_issue -> Require approval (browser).
--   cd apps/web && pnpm exec wrangler d1 execute acl --local --file ../../claude-plugin/scripts/e2e-backend.fixture.sql
INSERT INTO guardrail (id, org_id, name, description, enabled, position, group_ids, created_at, updated_at)
SELECT 'wf_e2e_browser', id, 'Jira tickets need approval', 'New Jira tickets are approved in the browser.', 1, 90, '[]',
       unixepoch() * 1000, unixepoch() * 1000
FROM organization LIMIT 1
ON CONFLICT DO NOTHING;
INSERT INTO guardrail_version (id, org_id, guardrail_id, version, definition, status, note, created_by, created_at)
SELECT 'wf_e2e_browser-v1', id, 'wf_e2e_browser', 1,
  '{"fallback":"block","nodes":[{"id":"start","type":"trigger","position":{"x":0,"y":0},"stages":["tool_call"]},{"id":"is_create","type":"condition","position":{"x":340,"y":0},"condition":{"field":"tool","values":["jira__create_issue"]}},{"id":"approve","type":"decision","position":{"x":680,"y":200},"action":"require_approval","method":"browser","timeoutSec":120,"reason":"New Jira tickets need your approval"},{"id":"allow","type":"decision","position":{"x":680,"y":0},"action":"allow","method":"admin","timeoutSec":300,"reason":""}],"edges":[{"id":"start-next","source":"start","sourceHandle":"next","target":"is_create"},{"id":"is_create-yes","source":"is_create","sourceHandle":"yes","target":"approve"},{"id":"is_create-no","source":"is_create","sourceHandle":"no","target":"allow"}]}',
  'published', 'e2e fixture', NULL, unixepoch() * 1000
FROM organization LIMIT 1
ON CONFLICT DO NOTHING;
