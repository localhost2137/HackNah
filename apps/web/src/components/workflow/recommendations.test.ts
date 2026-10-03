import { defaultWorkflow, type PolicyGraph } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import { recommendSteps } from './recommendations.ts'

const graph = () => structuredClone(defaultWorkflow)
const find = (g: PolicyGraph, source: string, handle: string, label: string) =>
  recommendSteps(g, source, handle).find((s) => s.label === label)!
const open = (g: PolicyGraph, source: string, handle: string) => {
  g.edges = g.edges.filter((e) => e.source !== source || e.sourceHandle !== handle)
  return g
}

describe('contextual step recommendations', () => {
  it('demotes both checks already passed and the next existing check', () => {
    expect(find(graph(), 'fingerprint', 'pass', 'Device fingerprint').recommended).toBe(false)
    expect(find(graph(), 'fingerprint', 'pass', 'Dangerous keywords').reason).toContain('next step')
    expect(find(graph(), 'fingerprint', 'pass', 'Judge model').recommended).toBe(true)
  })
  it('ignores checks that exist only on a sibling branch', () => {
    expect(find(graph(), 'fingerprint', 'new', 'Dangerous keywords').recommended).toBe(true)
  })
  it('does not treat disabled checks as completed', () => {
    const g = graph()
    const node = g.nodes.find((n) => n.id === 'fingerprint')!
    if (node.type === 'check') node.enabled = false
    expect(find(g, 'fingerprint', 'pass', 'Device fingerprint').recommended).toBe(true)
  })
  it('prioritizes approval for a new device, never allow', () => {
    const g = open(graph(), 'fingerprint', 'new')
    expect(recommendSteps(g, 'fingerprint', 'new')[0]?.label).toBe('Require approval')
    expect(find(g, 'fingerprint', 'new', 'Allow').recommended).toBe(false)
  })
  it('prioritizes block and approval on failed checks', () => {
    const g = open(graph(), 'keywords', 'fail')
    expect(
      recommendSteps(g, 'keywords', 'fail')
        .slice(0, 2)
        .map((s) => s.label),
    ).toEqual(['Block', 'Require approval'])
    expect(find(g, 'keywords', 'fail', 'Allow').reason).toContain('flagged')
  })
  it('carries risk through a route instead of recommending allow after a failure', () => {
    const g = open(graph(), 'keywords', 'fail')
    g.nodes.push({
      id: 'route',
      type: 'match',
      position: { x: 0, y: 0 },
      mode: 'all',
      conditions: [],
      label: '',
    })
    g.edges.push({ id: 'r', source: 'keywords', sourceHandle: 'fail', target: 'route' })
    expect(find(g, 'route', 'match', 'Allow').recommended).toBe(false)
    expect(recommendSteps(g, 'route', 'match')[0]?.label).toBe('Block')
  })
  it('does not claim a check ran on all incoming paths when one bypasses it', () => {
    const g = graph()
    g.nodes.push({
      id: 'merge',
      type: 'match',
      position: { x: 0, y: 0 },
      mode: 'all',
      conditions: [],
      label: '',
    })
    g.edges = g.edges.filter(
      (e) => e.source !== 'keywords' && !(e.source === 'fingerprint' && e.sourceHandle === 'new'),
    )
    g.edges.push(
      { id: 'a', source: 'keywords', sourceHandle: 'pass', target: 'merge' },
      { id: 'b', source: 'fingerprint', sourceHandle: 'new', target: 'merge' },
    )
    expect(find(g, 'merge', 'match', 'Dangerous keywords').recommended).toBe(true)
    expect(find(g, 'merge', 'match', 'Device fingerprint').recommended).toBe(false)
  })
  it('keeps terminal choices visible but unavailable when insertion would cut off the path', () => {
    const suggestion = find(graph(), 'fingerprint', 'pass', 'Block')
    expect(suggestion.disabled).toBe(true)
    expect(suggestion.reason).toContain('Dangerous keywords')
  })
  it('limits recommendations to three and keeps all eight elements accessible', () => {
    const choices = recommendSteps(graph(), 'keywords', 'pass')
    expect(choices).toHaveLength(8)
    expect(choices.filter((s) => s.recommended).length).toBeLessThanOrEqual(3)
  })
  it('handles draft cycles without hanging', () => {
    const g = graph()
    g.edges.push({ id: 'cycle', source: 'keywords', sourceHandle: 'pass', target: 'fingerprint' })
    expect(recommendSteps(g, 'fingerprint', 'pass')).toHaveLength(8)
  })
})
