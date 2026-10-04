import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

function database() {
  const db = new DatabaseSync(':memory:')
  for (const name of [
    '0000_init',
    '0001_sso',
    '0002_admin_role',
    '0003_single_tenant',
    '0004_group_permissions',
    '0005_workflows',
    '0006_group_mcp_permissions',
    '0007_mock_mcp',
    '0008_limits_and_models',
    '0009_model_api_format',
    '0010_analysis_runs',
  ]) {
    db.exec(
      readFileSync(new URL(`../../../../packages/db/drizzle/${name}.sql`, import.meta.url), 'utf8'),
    )
  }
  return db
}
const revision = (db: DatabaseSync, org = 'test') =>
  Number(
    db.prepare('SELECT revision FROM analysis_revision WHERE org_id = ?').get(org)?.revision ?? 0,
  )
function save(db: DatabaseSync, id: string, dataset: string) {
  db.prepare('INSERT INTO analysis_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'test',
    dataset,
    revision(db),
    'catalog-v1',
    'admin',
    1,
    2400,
    1800,
    `test/analysis/${id}.json`,
  )
}
const valid = (db: DatabaseSync) =>
  db
    .prepare(
      'SELECT id FROM analysis_run WHERE org_id = ? AND revision = ? AND catalog_version = ? ORDER BY id',
    )
    .all('test', revision(db), 'catalog-v1')

describe('persistent analysis rules revision', () => {
  it('retains indexed results between reads and invalidates every dataset on rule changes, even reverts', () => {
    const db = database()
    try {
      db.exec(
        "INSERT INTO workflow (id, org_id, name, enabled, position, group_ids, created_at, updated_at) VALUES ('w','test','Guard',1,0,'[]',0,0)",
      )
      save(db, 'a', 'prompt-injection')
      save(db, 'b', 'tool-poisoning')
      expect(valid(db)).toEqual([{ id: 'a' }, { id: 'b' }])
      expect(valid(db)).toEqual([{ id: 'a' }, { id: 'b' }])
      db.exec("UPDATE workflow SET enabled = 0 WHERE id = 'w'")
      expect(valid(db)).toEqual([])
      db.exec("UPDATE workflow SET enabled = 1 WHERE id = 'w'")
      expect(valid(db)).toEqual([])
      save(db, 'c', 'prompt-injection')
      expect(valid(db)).toEqual([{ id: 'c' }])
      // Persisting a stale in-flight run cannot make it visible under the new revision.
      db.exec(
        "INSERT INTO analysis_run VALUES ('late','test','prompt-injection',1,'catalog-v1','admin',2,1,1,'test/analysis/late.json')",
      )
      expect(valid(db)).toEqual([{ id: 'c' }])
    } finally {
      db.close()
    }
  })

  it('tracks workflow definitions, access rules, rate limits and integration changes', () => {
    const db = database()
    try {
      const edits = [
        "INSERT INTO workflow (id, org_id, name, enabled, position, group_ids, created_at, updated_at) VALUES ('w','test','Guard',1,0,'[]',0,0)",
        "INSERT INTO workflow_version (id,org_id,workflow_id,version,definition,status,created_at) VALUES ('v','test','w',1,'{}','draft',0)",
        "UPDATE workflow_version SET status='published' WHERE id='v'",
        "INSERT INTO `group` (id,org_id,name,is_default,permissions,created_at) VALUES ('g','test','Analysts',0,'{}',0)",
        "UPDATE `group` SET permissions='{}' WHERE id='g'",
        "INSERT INTO resource (id,org_id,name,tool_patterns,created_at) VALUES ('r','test','Docs','[]',0)",
        "INSERT INTO resource_grant VALUES ('r','group','g',0)",
        "DELETE FROM resource_grant WHERE resource_id='r'",
        "INSERT INTO rate_limit (id,org_id,scope,target,\"limit\",window_sec,per,enabled,created_at) VALUES ('rl','test','model','*',10,60,'user',1,0)",
        "DELETE FROM rate_limit WHERE id='rl'",
        "INSERT INTO mcp_server (id,org_id,slug,name,url,auth_type,credential_mode,tools,enabled,created_at) VALUES ('s','test','s','Server','https://example.invalid','none','user','[]',1,0)",
        'UPDATE mcp_server SET tools=\'[{"name":"new_tool"}]\' WHERE id=\'s\'',
        "DELETE FROM workflow_version WHERE id='v'",
        "INSERT INTO model (id,org_id,pattern,created_at) VALUES ('model','test','*',0)",
        "UPDATE model SET enabled=0 WHERE id='model'",
        "DELETE FROM model WHERE id='model'",
      ]
      for (const edit of edits) {
        const before = revision(db)
        db.exec(edit)
        expect(revision(db), edit).toBeGreaterThan(before)
      }
      const before = revision(db)
      db.exec("UPDATE mcp_server SET tools_refreshed_at=123 WHERE id='s'")
      expect(revision(db)).toBe(before)
    } finally {
      db.close()
    }
  })

  it('isolates orgs and rolls revision changes back with failed transactions', () => {
    const db = database()
    try {
      save(db, 'a', 'prompt-injection')
      db.exec(
        "INSERT INTO workflow (id, org_id, name, enabled, position, group_ids, created_at, updated_at) VALUES ('other','another','Guard',1,0,'[]',0,0)",
      )
      expect(valid(db)).toEqual([{ id: 'a' }])
      db.exec(
        "BEGIN; INSERT INTO workflow (id, org_id, name, enabled, position, group_ids, created_at, updated_at) VALUES ('rolled','test','Guard',1,0,'[]',0,0); ROLLBACK;",
      )
      expect(valid(db)).toEqual([{ id: 'a' }])
      expect(revision(db)).toBe(0)
    } finally {
      db.close()
    }
  })
})
