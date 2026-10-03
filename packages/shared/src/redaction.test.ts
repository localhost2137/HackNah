import { describe, expect, it } from 'vitest'
import { RedactionVault } from './redaction.ts'

const all = {
  secrets: true,
  pii: ['email', 'phone', 'iban', 'credit_card', 'ipv4', 'pesel'] as const,
}
const opts = { secrets: all.secrets, pii: [...all.pii] }

describe('RedactionVault', () => {
  it('replaces secrets and PII with stable placeholders', () => {
    const vault = new RedactionVault()
    const { text, count } = vault.redact(
      'mail jan@acme.com, again jan@acme.com, key AKIAABCDEFGHIJKLMNOP, card 4111 1111 1111 1111',
      opts,
    )
    expect(count).toBe(4)
    expect(text).toBe(
      'mail [REDACTED_EMAIL_1], again [REDACTED_EMAIL_1], key [REDACTED_AWS_KEY_1], card [REDACTED_CARD_1]',
    )
  })

  it('only redacts the value of key=value secrets', () => {
    const vault = new RedactionVault()
    expect(vault.redact('password: hunter2hunter2', opts).text).toBe(
      'password: [REDACTED_SECRET_1]',
    )
  })

  it('validates checksums to avoid false positives', () => {
    const vault = new RedactionVault()
    expect(vault.redact('order 1234 5678 9012 3456', opts).count).toBe(0)
    expect(vault.redact('PESEL 44051401359', opts).text).toBe('PESEL [REDACTED_PESEL_1]')
    expect(vault.redact('IBAN PL61 1090 1014 0000 0712 1981 2874', opts).text).toBe(
      'IBAN [REDACTED_IBAN_1]',
    )
  })

  it('restores placeholders deeply and survives serialization', () => {
    const first = new RedactionVault()
    first.redact('contact anna@example.org', opts)
    const second = new RedactionVault(first.toJSON())
    expect(
      second.restoreDeep({ to: ['[REDACTED_EMAIL_1]'], body: 'hi [REDACTED_EMAIL_1]' }),
    ).toEqual({
      to: ['anna@example.org'],
      body: 'hi anna@example.org',
    })
    // Numbering continues after a restore instead of reusing ids.
    expect(second.redact('bob@example.org', opts).text).toBe('[REDACTED_EMAIL_2]')
  })

  it('leaves unknown placeholders alone', () => {
    expect(new RedactionVault().restore('[REDACTED_EMAIL_9]')).toBe('[REDACTED_EMAIL_9]')
  })
})
