export const datasets = [
  {
    id: 'prompt-injection',
    name: 'Prompt injection',
    description: 'Synthetic model traffic with direct, indirect and encoded instruction attacks.',
    tag: 'LLM',
    eventCount: 2400,
    templatePrefix: 'PROMPT',
    seed: 7391,
  },
  {
    id: 'tool-poisoning',
    name: 'Tool poisoning',
    description: 'Tool calls mixing routine work with malicious metadata and hidden instructions.',
    tag: 'MCP',
    eventCount: 1800,
    templatePrefix: 'META',
    seed: 12497,
  },
  {
    id: 'definition-drift',
    name: 'Definition drift',
    description: 'Tool traffic before and after definition changes, including unsafe operations.',
    tag: 'MCP',
    eventCount: 1600,
    templatePrefix: 'RUG',
    seed: 38177,
  },
  {
    id: 'argument-exfiltration',
    name: 'Argument exfiltration',
    description:
      'Routine tool traffic interspersed with synthetic secrets in arguments and destinations.',
    tag: 'MCP',
    eventCount: 2200,
    templatePrefix: 'LEAK',
    seed: 55763,
  },
]
export const trafficWindow = { start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' }
