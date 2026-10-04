import { type BlockId, blocks, defaultGuardrail, type PolicyGraph, palette } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import { recommendSteps } from './recommendations.ts'

const graph = () => structuredClone(defaultGuardrail)
const find = (g: PolicyGraph, source: string, handle: string, id: BlockId) =>
  recommendSteps(g, source, handle).find((s) => s.block.id === id)!
const recommended = (g: PolicyGraph, source: string, handle: string) =>
  recommendSteps(g, source, handle)
    .filter((s) => s.recommended)
    .map((s) => s.block.id)
const open = (g: PolicyGraph, source: string, handle: string) => {
  g.edges = g.edges.filter((e) => e.source !== source || e.sourceHandle !== handle)
  return g
}

describe('contextual step recommendations', () => {
  it('recommends the blocks the source output declares as common next, in that order', () => {
    const g = open(graph(), 'keywords', 'fail')
    const declared = blocks.keywords.outputs.find((o) => o.id === 'fail')!.next
    expect(recommended(g, 'keywords', 'fail')).toEqual(declared)
  })
  it('demotes both checks already passed and the next existing check', () => {
    expect(find(graph(), 'fingerprint', 'pass', 'fingerprint').recommended).toBe(false)
    expect(find(graph(), 'fingerprint', 'pass', 'keywords').reason).toContain('next step')
    expect(find(graph(), 'fingerprint', 'pass', 'keywords').recommended).toBe(false)
    expect(find(graph(), 'fingerprint', 'pass', 'judge').recommended).toBe(true)
  })
  it('ignores checks that exist only on a sibling branch', () => {
    expect(find(graph(), 'fingerprint', 'new', 'keywords').recommended).toBe(true)
  })
  it('does not treat disabled checks as completed', () => {
    const g = graph()
    const node = g.nodes.find((n) => n.id === 'keywords')!
    if (node.type === 'check') node.enabled = false
    expect(find(g, 'fingerprint', 'pass', 'keywords').reason).toBe('')
    expect(find(g, 'fingerprint', 'pass', 'keywords').recommended).toBe(true)
  })
  it('prioritizes approval for a new device, never allow', () => {
    const g = open(graph(), 'fingerprint', 'new')
    expect(recommendSteps(g, 'fingerprint', 'new')[0]?.block.id).toBe('approve_admin')
    expect(find(g, 'fingerprint', 'new', 'allow').recommended).toBe(false)
  })
  it('prioritizes block and approval on failed checks', () => {
    const g = open(graph(), 'keywords', 'fail')
    expect(
      recommendSteps(g, 'keywords', 'fail')
        .slice(0, 2)
        .map((s) => s.block.id),
    ).toEqual(['block', 'approve_admin'])
    expect(find(g, 'keywords', 'fail', 'allow').reason).toContain('flagged')
  })
  it('carries risk through a condition instead of recommending allow after a failure', () => {
    const g = open(graph(), 'keywords', 'fail')
    g.nodes.push({
      id: 'route',
      type: 'condition',
      position: { x: 0, y: 0 },
      condition: { field: 'tool', values: [] },
    })
    g.edges.push({ id: 'r', source: 'keywords', sourceHandle: 'fail', target: 'route' })
    expect(find(g, 'route', 'no', 'allow').recommended).toBe(false)
    expect(recommendSteps(g, 'route', 'yes')[0]?.block.id).toBe('block')
  })
  it('offers the device-side approvals where the plugin signals are checked', () => {
    const g = graph()
    g.nodes.push({
      id: 'guard',
      type: 'check',
      position: { x: 0, y: 0 },
      enabled: true,
      check: { type: 'untrusted_content', windowMinutes: 10 },
    })
    expect(recommended(g, 'guard', 'tainted')).toEqual([
      'approve_browser',
      'approve_touchid',
      'judge',
      'block',
    ])
  })
  it('does not claim a check ran on all incoming paths when one bypasses it', () => {
    const g = graph()
    g.nodes.push({
      id: 'merge',
      type: 'condition',
      position: { x: 0, y: 0 },
      condition: { field: 'tool', values: [] },
    })
    g.edges = g.edges.filter(
      (e) => e.source !== 'keywords' && !(e.source === 'fingerprint' && e.sourceHandle === 'new'),
    )
    g.edges.push(
      { id: 'a', source: 'keywords', sourceHandle: 'pass', target: 'merge' },
      { id: 'b', source: 'fingerprint', sourceHandle: 'new', target: 'merge' },
    )
    expect(find(g, 'merge', 'yes', 'keywords').reason).toBe('')
    expect(find(g, 'merge', 'yes', 'fingerprint').reason).toContain('Already checked')
  })
  it('keeps terminal choices visible but unavailable when insertion would cut off the path', () => {
    const suggestion = find(graph(), 'fingerprint', 'pass', 'block')
    expect(suggestion.disabled).toBe(true)
    expect(suggestion.reason).toContain('Keyword match')
  })
  it('limits recommendations to four and keeps every block accessible', () => {
    const choices = recommendSteps(graph(), 'keywords', 'pass')
    expect(choices).toHaveLength(palette.length)
    expect(new Set(choices.map((s) => s.block.id)).size).toBe(palette.length)
    expect(choices.filter((s) => s.recommended).length).toBeLessThanOrEqual(4)
  })
  it('only declares blocks that exist as common next steps', () => {
    for (const block of Object.values(blocks))
      for (const output of block.outputs)
        for (const id of output.next) expect(blocks[id], `${block.id}.${output.id}`).toBeDefined()
  })
  it('handles draft cycles without hanging', () => {
    const g = graph()
    g.edges.push({ id: 'cycle', source: 'keywords', sourceHandle: 'pass', target: 'fingerprint' })
    expect(recommendSteps(g, 'fingerprint', 'pass')).toHaveLength(palette.length)
  })
})
