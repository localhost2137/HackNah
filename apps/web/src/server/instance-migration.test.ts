import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const migration = (name: string) =>
  readFileSync(new URL(`../../../../packages/db/drizzle/${name}.sql`, import.meta.url), 'utf8')
function database() {
  const db = new DatabaseSync(':memory:')
  db.exec(migration('0000_init'))
  db.exec(migration('0001_sso'))
  db.exec(migration('0002_admin_role'))
  return db
}
function addUser(db: DatabaseSync, id: string) {
  db.prepare(
    'INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,0,0)',
  ).run(id, id, `${id}@test.local`)
}

describe('single-tenant migration', () => {
  it('bootstraps only the first account as admin and rejects a second scope', () => {
    const db = database()
    try {
      db.exec(migration('0003_single_tenant'))
      addUser(db, 'first')
      addUser(db, 'second')
      expect(db.prepare('SELECT user_id,role FROM member').all()).toEqual([
        { user_id: 'first', role: 'admin' },
      ])
      expect(() =>
        db.exec("INSERT INTO organization VALUES ('other','Other','other',NULL,NULL,0)"),
      ).toThrow()
    } finally {
      db.close()
    }
  })
  it('preserves an existing scope and does not promote subsequent signups', () => {
    const db = database()
    try {
      db.exec("INSERT INTO organization VALUES ('existing','Existing','existing',NULL,NULL,0)")
      addUser(db, 'existing-admin')
      db.exec("INSERT INTO member VALUES ('m','existing','existing-admin','admin',0)")
      db.exec(migration('0003_single_tenant'))
      addUser(db, 'new')
      expect(db.prepare('SELECT id FROM organization').all()).toEqual([{ id: 'existing' }])
      expect(db.prepare('SELECT user_id FROM member').all()).toEqual([
        { user_id: 'existing-admin' },
      ])
    } finally {
      db.close()
    }
  })
  it('creates one default group that keeps existing access', () => {
    const db = database()
    try {
      db.exec("INSERT INTO `group` VALUES ('g1','x','Backend',NULL,0)")
      db.exec(migration('0003_single_tenant'))
      db.exec(migration('0004_group_permissions'))
      expect(db.prepare('SELECT id,is_default,permissions FROM `group` ORDER BY id').all()).toEqual(
        [
          { id: 'g1', is_default: 0, permissions: '{"models":[],"builtinTools":[]}' },
          {
            id: 'grp_default',
            is_default: 1,
            permissions: '{"models":["*"],"builtinTools":["*"]}',
          },
        ],
      )
      expect(() =>
        db.exec(
          "INSERT INTO `group` (id,org_id,name,is_default,created_at) SELECT 'g2',id,'B',1,0 FROM organization",
        ),
      ).toThrow()
    } finally {
      db.close()
    }
  })
  it('adds empty MCP permissions to existing groups', () => {
    const db = database()
    try {
      db.exec("INSERT INTO `group` VALUES ('g1','x','Backend',NULL,0)")
      db.exec(migration('0003_single_tenant'))
      db.exec(migration('0004_group_permissions'))
      db.exec(migration('0006_group_mcp_permissions'))
      expect(db.prepare('SELECT id,permissions FROM `group` ORDER BY id').all()).toEqual([
        { id: 'g1', permissions: '{"models":[],"builtinTools":[],"mcp":{}}' },
        { id: 'grp_default', permissions: '{"models":["*"],"builtinTools":["*"],"mcp":{}}' },
      ])
    } finally {
      db.close()
    }
  })
  it('turns single-server resources and group MCP permissions into multi-server resources', () => {
    const db = database()
    try {
      db.exec("INSERT INTO `group` VALUES ('g1','x','Backend',NULL,0)")
      db.exec(migration('0003_single_tenant'))
      db.exec(migration('0004_group_permissions'))
      db.exec(migration('0006_group_mcp_permissions'))
      const org = (db.prepare('SELECT id FROM organization').get() as { id: string }).id
      db.prepare(
        "INSERT INTO mcp_server (id,org_id,name,slug,url,auth_type,credential_mode,tools,enabled,created_at) VALUES ('gh',?,'GitHub','gh','https://x','none','org','[]',1,0)",
      ).run(org)
      db.exec(
        "INSERT INTO resource (id,org_id,name,mcp_server_id,tool_patterns,created_at) VALUES ('r_read','x','Read','gh','[\"get_*\"]',0),('r_all','x','All','gh','[]',0)",
      )
      db.exec(
        'UPDATE `group` SET permissions = json_set(permissions, \'$.mcp\', json(\'{"gh":["list_*"],"*":["search_*"]}\')) WHERE id = \'g1\'',
      )
      db.exec(migration('0011_resource_tools'))

      expect(db.prepare('SELECT id,tools,mcp_server_id FROM resource ORDER BY id').all()).toEqual([
        { id: 'r_all', tools: '{"gh":["*"]}', mcp_server_id: null },
        { id: 'r_read', tools: '{"gh":["get_*"]}', mcp_server_id: null },
        { id: 'res_grp_g1', tools: '{"gh":["list_*"],"*":["search_*"]}', mcp_server_id: null },
      ])
      expect(
        db.prepare('SELECT resource_id,subject_type,subject_id FROM resource_grant').all(),
      ).toEqual([{ resource_id: 'res_grp_g1', subject_type: 'group', subject_id: 'g1' }])
      expect(db.prepare('SELECT id,permissions FROM `group` ORDER BY id').all()).toEqual([
        { id: 'g1', permissions: '{"models":[],"builtinTools":[]}' },
        { id: 'grp_default', permissions: '{"models":["*"],"builtinTools":["*"]}' },
      ])
    } finally {
      db.close()
    }
  })
  it('refuses to silently merge an existing multi-tenant installation', () => {
    const db = database()
    try {
      db.exec("INSERT INTO organization VALUES ('a','A','a',NULL,NULL,0),('b','B','b',NULL,NULL,0)")
      expect(() => db.exec(migration('0003_single_tenant'))).toThrow()
      expect(db.prepare('SELECT count(*) AS n FROM organization').get()).toEqual({ n: 2 })
    } finally {
      db.close()
    }
  })
})
