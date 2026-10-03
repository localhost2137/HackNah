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
