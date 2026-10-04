import { describe, expect, it } from 'vitest'
import { findInternalTool, type InternalContext, internalTools, isInternalTool } from './tools.ts'

const context = {} as InternalContext

describe('built-in platform MCP tools', () => {
  it('uses a namespace that cannot collide with connected MCP servers', () => {
    const names = internalTools.map((t) => t.definition.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.every(isInternalTool)).toBe(true)
    expect(isInternalTool('hacknah__create_workflow')).toBe(false)
    expect(isInternalTool('github__hacknah_create_workflow')).toBe(false)
    for (const tool of internalTools) {
      expect(tool.definition.inputSchema).toMatchObject({ type: 'object' })
      expect(tool.definition.annotations).toMatchObject({
        readOnlyHint: tool.readOnly,
        openWorldHint: false,
      })
    }
  })
  it('validates arguments before touching platform services', async () => {
    await expect(async () =>
      findInternalTool('hacknah_create_workflow')!.invoke({ name: '' }, context),
    ).rejects.toThrow()
    await expect(async () =>
      findInternalTool('hacknah_run_analysis')!.invoke(
        { datasetId: 'prompt-injection', orgId: 'other' },
        context,
      ),
    ).rejects.toThrow()
    await expect(async () =>
      findInternalTool('hacknah_list_events')!.invoke({ limit: 10000 }, context),
    ).rejects.toThrow()
  })
  it('exposes a usable workflow schema and the curated datasets without a connection', async () => {
    const schema = await findInternalTool('hacknah_workflow_schema')!.invoke({}, context)
    expect(schema).toMatchObject({
      schema: {
        type: 'object',
        properties: { nodes: { type: 'array' }, edges: { type: 'array' } },
      },
      starter: { nodes: expect.any(Array) },
    })
    const datasets = await findInternalTool('hacknah_list_datasets')!.invoke({}, context)
    expect(datasets).toMatchObject({
      datasets: expect.arrayContaining([expect.objectContaining({ id: 'prompt-injection' })]),
    })
  })
})
