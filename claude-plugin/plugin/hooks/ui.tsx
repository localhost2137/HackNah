// hy-guard inside Claude Code: one card per hy-guard tool call that updates in place
// (waiting → approved / blocked), plus optional status line and approval band, and
// toasts. Reads the state the bridge writes (bridge/ui-state.mjs).
//
// Options (/config): ui_cards approvals|all|off (default approvals: only calls that needed
// approval or were blocked, so MCP-heavy work isn't flooded), ui_status_line (off),
// ui_band (off). Env overrides for dev: HY_UI_CARDS, HY_UI_STATUS, HY_UI_BAND.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { UiCall, UiState } from '../types'

const PREFIX = 'mcp__plugin_hy-guard_gateway__'
const ui = atom({ plugin: 'hy-guard', key: 'ui' } as const, null as UiState | null)
const WAITING = new Set(['waiting_confirm', 'waiting_touchid', 'waiting_browser'])

const COLOR: Record<string, string> = {
  running: 'cyan',
  waiting_confirm: 'yellow',
  waiting_touchid: 'yellow',
  waiting_browser: 'yellow',
  done: 'green',
  blocked: 'red',
}

const APPROVAL: Record<string, string> = {
  none: 'no approval needed',
  confirm: 'you confirm each call',
  touchid: 'Touch ID for each call',
  browser: 'approval in the browser with a fresh sign-in',
}

function stateLine(call: UiCall | undefined, isRunning: boolean, isErrored: boolean): string {
  if (!call) return isRunning ? '… sending through hy-guard' : isErrored ? '⛔ refused' : '✓ done'
  switch (call.state) {
    case 'waiting_touchid':
      return '🔐 Touch ID required: approve on your Mac (sensor or prompt)'
    case 'waiting_browser':
      return `🌐 Approve in your browser (fresh sign-in)${call.url ? `: ${call.url}` : ''}`
    case 'waiting_confirm':
      return '❓ Confirm in the dialog below'
    case 'running':
      return '… running, signed with this device key'
    case 'blocked':
      return `⛔ ${call.note ?? 'blocked'}`
    default:
      return call.note ?? '✓ done'
  }
}

function statusLine(s: UiState): string {
  // Claude Code prefixes the plugin's name ("hy-guard: ...")
  if (!s.signed_in) return '○ not signed in'
  const os = s.posture?.os
  const mark = (v: boolean | null | undefined) => (v === true ? '✓' : v === false ? '✗' : '?')
  return [
    '●',
    s.user ?? '',
    s.device_code ? `· ${s.device_code}` : '',
    s.posture?.zta !== null && s.posture?.zta !== undefined ? `· CrowdStrike ${s.posture.zta}` : '',
    os ? `· FileVault ${mark(os.fv)} SIP ${mark(os.sip)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

type Cards = 'approvals' | 'all' | 'off'
const asCards = (v: unknown): Cards | undefined => (v === 'approvals' || v === 'all' || v === 'off' ? v : undefined)
const asBool = (v: string | undefined) => (v === undefined || v === '' ? undefined : v === '1' || v === 'true')

/** Worth a card in "approvals" mode: it needed an approval, is waiting for one, or was blocked. */
const interesting = (c: UiCall | undefined) =>
  Boolean(c && ((c.approval && c.approval !== 'none') || c.state === 'blocked' || WAITING.has(c.state)))

export const register: Register = (on, options) => {
  // Plugin options (/config); HY_UI_* environment variables override them (dev).
  const cfg = {
    cards: asCards(options.ui_cards) ?? ('approvals' as Cards),
    status: options.ui_status_line === true,
    band: options.ui_band === true,
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    cfg.cards = asCards(await $.env.get('HY_UI_CARDS')) ?? cfg.cards
    cfg.status = asBool(await $.env.get('HY_UI_STATUS')) ?? cfg.status
    cfg.band = asBool(await $.env.get('HY_UI_BAND')) ?? cfg.band
    if (!cfg.status) $.ui.status(undefined) // switched off: clear a line from before
    let dataDir = await $.env.get('HY_DATA_DIR')
    if (!dataDir) {
      try {
        dataDir = (await $.fs.read(`${$.plugin.root}/.runtime/data-dir`)).trim()
      } catch {
        return result
      }
    }
    const path = `${dataDir}/ui-state.json`
    let lastText = ''
    let lastEventId: string | null = null
    $.clock.every(700, async () => {
      let text: string
      try {
        text = await $.fs.read(path)
      } catch {
        return
      }
      if (text === lastText) return
      lastText = text
      let s: UiState
      try {
        s = JSON.parse(text)
      } catch {
        return
      }
      await update($, ui, () => s)
      if (cfg.status) $.ui.status(statusLine(s))
      const ev = s.last_event
      if (cfg.cards !== 'off' && ev && lastEventId !== null && ev.id !== lastEventId) $.ui.toast(ev.text)
      lastEventId = ev?.id ?? ''
    })
    return result
  })

  // Claude Code folds runs of tool calls into one group line; unfold groups made only of
  // hy-guard calls so each draws as its own row (the card below).
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (cfg.cards === 'off' || e.props.isExpanded) return next(e)
    const ours = e.props.calls.length > 0 && e.props.calls.every(c => c.tool.startsWith(PREFIX))
    if (!ours) return next(e)
    const s = await read($, ui)
    const wanted = cfg.cards === 'all' || e.props.calls.some(c => interesting(c.tool_use_id ? s?.calls?.[c.tool_use_id] : undefined))
    return wanted ? next({ ...e, props: { ...e.props, isExpanded: true } }) : next(e)
  })

  // The tool row in the conversation, drawn as a hy-guard card.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (cfg.cards === 'off' || !e.props.tool.startsWith(PREFIX)) return next(e)
    const s = await read($, ui)
    const call = s?.calls?.[e.props.tool_use_id]
    if (cfg.cards === 'approvals' && !interesting(call)) return next(e)
    const name = e.props.tool.slice(PREFIX.length)
    const state = call?.state ?? (e.props.isRunning ? 'running' : e.props.isErrored ? 'blocked' : 'done')
    const color = COLOR[state] ?? 'gray'
    const { Box, Text } = $.ui.resolve(e)
    const rows = [
      <Text key="h">
        <Text bold color={color}>
          hy-guard
        </Text>
        <Text> · {name}</Text>
        {call?.approval ? <Text dimColor> · {APPROVAL[call.approval] ?? call.approval}</Text> : <Text> </Text>}
      </Text>,
    ]
    if (call?.description) rows.push(<Text key="d">{call.description}</Text>)
    if (call?.args) rows.push(<Text key="a" dimColor>{call.args.replaceAll('\n', ' · ')}</Text>)
    rows.push(
      <Text key="s" color={color}>
        {stateLine(call, e.props.isRunning, e.props.isErrored)}
      </Text>,
    )
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        {rows}
      </Box>
    )
  })

  // While an approval is pending, a band above the prompt says what and where.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.band || e.props.hasSurvey) return next(e)
    const s = await read($, ui)
    const pending = Object.values(s?.calls ?? {}).filter(
      c => WAITING.has(c.state) && Date.now() - Date.parse(c.at) < 3 * 60_000,
    )
    const c = pending.at(-1)
    if (!c) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const title =
      c.state === 'waiting_touchid'
        ? '🔐 hy-guard: Touch ID requested'
        : c.state === 'waiting_browser'
          ? '🌐 hy-guard: approve in your browser'
          : '❓ hy-guard: confirm this action'
    return (
      <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow">
          {title}
        </Text>
        <Text>
          {c.description ?? c.tool} <Text dimColor>({(c.args ?? '').replaceAll('\n', ', ')})</Text>
        </Text>
        <Text dimColor>
          {c.state === 'waiting_touchid'
            ? 'Requested by Claude Code on this Mac. Cancel in the macOS prompt if you did not ask for this.'
            : c.state === 'waiting_browser'
              ? `Opened in your browser${c.url ? `: ${c.url}` : ''}. Deny there or press Esc here to cancel.`
              : 'Accept or decline in the dialog.'}
        </Text>
      </Box>
    )
  })
}
