import type { ApprovalView, GatewayEvent, LiveMessage } from '@acl/shared'
import * as React from 'react'

type LiveState = {
  connected: boolean
  pendingApprovals: ApprovalView[]
  /** Most recent events first, capped. */
  events: GatewayEvent[]
}

const MAX_EVENTS = 200
const LiveContext = React.createContext<LiveState>({
  connected: false,
  pendingApprovals: [],
  events: [],
})

type ServerMessage = LiveMessage | { type: 'hello'; pending: ApprovalView[] }

function reduce(state: LiveState, msg: ServerMessage): LiveState {
  switch (msg.type) {
    case 'hello':
      return { ...state, pendingApprovals: msg.pending }
    case 'event':
      return {
        ...state,
        events: [msg.event, ...state.events.filter((e) => e.id !== msg.event.id)].slice(
          0,
          MAX_EVENTS,
        ),
      }
    case 'approval_created':
      return {
        ...state,
        pendingApprovals: [
          msg.approval,
          ...state.pendingApprovals.filter((a) => a.id !== msg.approval.id),
        ],
      }
    case 'approval_decided':
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((a) => a.id !== msg.approvalId),
      }
  }
}

/** Single WebSocket per tab to the org's live stream (proxied through `/api/live`). */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<LiveState>({
    connected: false,
    pendingApprovals: [],
    events: [],
  })

  React.useEffect(() => {
    let ws: WebSocket | null = null
    let retry = 0
    let stopped = false
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      const url = new URL('/api/live', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(url)
      ws.onopen = () => {
        retry = 0
        setState((s) => ({ ...s, connected: true }))
        pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000)
      }
      ws.onmessage = (e) => {
        if (e.data === 'pong') return
        try {
          const msg = JSON.parse(String(e.data)) as ServerMessage
          setState((s) => reduce(s, msg))
        } catch {}
      }
      ws.onclose = () => {
        clearInterval(pingTimer)
        setState((s) => ({ ...s, connected: false }))
        if (stopped) return
        retry = Math.min(retry + 1, 6)
        reconnectTimer = setTimeout(connect, 500 * 2 ** retry)
      }
    }
    connect()
    return () => {
      stopped = true
      clearInterval(pingTimer)
      clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>
}

export function useLive() {
  return React.useContext(LiveContext)
}
