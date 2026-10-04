import { Button } from '@acl/ui'
import { useRouter } from '@tanstack/react-router'
import { type Driver, type DriveStep, driver } from 'driver.js'
import { Compass } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'

type TourStep = {
  /** Page the step lives on; a function resolves it at runtime and `undefined` skips the step. */
  route: string | (() => string | undefined)
  /** `[data-tour="…"]` target; without one the popover is centered on the page. */
  target?: string
  title: string
  description: string
  side?: 'top' | 'right' | 'bottom' | 'left'
}

function buildSteps(guardrailHref: () => string | undefined): TourStep[] {
  return [
    {
      route: '/',
      title: 'Welcome to Hack?Nah!',
      description:
        'Hack?Nah! is a security gateway between your team’s AI agents (like Claude Code) and the models, tools and data they use. Every prompt and tool call passes through it, gets checked against your guardrails and is logged.<br><br>This 2-minute tour shows the main screens. Use <kbd>←</kbd> <kbd>→</kbd> or the buttons below.',
    },
    {
      route: '/',
      target: 'nav',
      side: 'right',
      title: 'Navigation',
      description:
        '<b>Policy</b> decides what agents may do, <b>Access</b> decides who may use which tools and data, and <b>System</b> connects laptops to the gateway.',
    },
    {
      route: '/',
      target: 'overview-stats',
      side: 'bottom',
      title: 'Live overview',
      description:
        'Requests going through the gateway, how many were blocked, how many needed a human approval, and tokens used. The time range buttons above switch between 1h and 30d.',
    },
    {
      route: '/',
      target: 'overview-traffic',
      side: 'bottom',
      title: 'Traffic over time',
      description: 'Allowed and blocked requests over time, so attacks show up as spikes in red.',
    },
    {
      route: '/',
      target: 'overview-flagged',
      side: 'top',
      title: 'Flagged requests',
      description:
        'The most recent blocked or manually approved requests, with the check that failed and a risk score. Clicking a row opens it in Logs.',
    },
    {
      route: '/events',
      target: 'events-filters',
      side: 'bottom',
      title: 'Logs',
      description:
        'Every prompt and tool call is logged. Filter by time, decision (allowed, blocked, approved), stage, or search by tool, model or trace id.',
    },
    {
      route: '/events',
      target: 'events-table',
      side: 'top',
      title: 'Every event, explained',
      description:
        'Click any row to see the full request, every guardrail check that ran on it, and why it was allowed or blocked.',
    },
    {
      route: '/events',
      target: 'events-actions',
      side: 'bottom',
      title: 'Live feed and export',
      description:
        '<b>Live</b> streams new events as they happen. CSV and JSONL export the filtered logs for audits or a SIEM.',
    },
    {
      route: '/events',
      target: 'events-approvals',
      side: 'bottom',
      title: 'Human approvals',
      description:
        'Risky actions can pause until a person approves them. Pending and past approvals are listed here.',
    },
    {
      route: '/guardrails',
      target: 'guardrail-list',
      side: 'top',
      title: 'Guardrails',
      description:
        'Guardrails decide whether a request is allowed, blocked or sent for approval. When several apply, the strictest outcome wins. Next, we’ll open one.',
    },
    {
      route: guardrailHref,
      target: 'guardrail-canvas',
      side: 'left',
      title: 'Visual policy editor',
      description:
        'A guardrail is a flowchart. A request enters at <b>Start</b>, passes through checks (prompt-injection detectors, data-leak scanners, allow-lists, ML classifiers…) and ends in a decision.',
    },
    {
      route: guardrailHref,
      target: 'guardrail-add-step',
      side: 'bottom',
      title: 'Add a step',
      description:
        'Adds a check, branch or decision. Suggested steps are listed first, based on what the guardrail already does.',
    },
    {
      route: guardrailHref,
      target: 'guardrail-test',
      side: 'bottom',
      title: 'Dry run',
      description:
        'Paste a sample prompt or tool call and see which path it takes through the flowchart, before anything is published.',
    },
    {
      route: guardrailHref,
      target: 'guardrail-impact',
      side: 'bottom',
      title: 'Impact on past traffic',
      description:
        'Replays recent real traffic against the draft and shows which past requests would now be blocked or allowed. Publishing creates a new version you can roll back.',
    },
    {
      route: '/datasets',
      target: 'datasets-table',
      side: 'top',
      title: 'Attack analysis',
      description:
        'Runs labelled datasets of attacks and normal prompts against your guardrails, and reports what they block, what they miss, and what they block by mistake.',
    },
    {
      route: '/datasets',
      target: 'datasets-import',
      side: 'bottom',
      title: 'Bring your own datasets',
      description: 'Import a dataset from Hugging Face or upload a JSONL file.',
    },
    {
      route: '/limits',
      target: 'limits-table',
      side: 'top',
      title: 'Limits',
      description:
        'Budgets and rate limits per user, group or organization. For example, $5 of model spend per user per day, or 20 GitHub issues per hour. A limit can warn or block.',
    },
    {
      route: '/models',
      target: 'models-table',
      side: 'top',
      title: 'Model catalog',
      description:
        'The models your team may use, where each one runs (Anthropic, OpenRouter, a local Ollama/vLLM) and what it costs. Requests for models outside the catalog are refused.',
    },
    {
      route: '/integrations',
      target: 'integrations-list',
      side: 'top',
      title: 'MCP integrations',
      description:
        'MCP servers like GitHub, Jira or Datadog sit behind the gateway. Their credentials stay on the server and never reach the developer’s laptop, and every tool call is checked.',
    },
    {
      route: '/settings/connect',
      target: 'connect-options',
      side: 'top',
      title: 'Connect Claude Code',
      description:
        'One script points Claude Code on a laptop at the gateway. From then on, every prompt and tool call it makes shows up in Logs and goes through your guardrails.',
    },
    {
      route: '/settings/connect',
      title: 'That’s the tour',
      description:
        'Explore on your own now. You can restart the tour any time with <b>Take the tour</b> in the top bar.',
    },
  ]
}

const selector = (target: string) => `[data-tour="${target}"]`

export function DemoTourButton() {
  const router = useRouter()
  const tour = useRef<Driver | null>(null)

  const start = useCallback(() => {
    tour.current?.destroy()
    let guardrailHref: string | undefined
    const steps = buildSteps(() => guardrailHref)

    const resolve = (step: TourStep) =>
      typeof step.route === 'function' ? step.route() : step.route

    const go = async (index: number, direction: 1 | -1) => {
      const instance = tour.current
      if (!instance) return
      const step = steps[index]
      if (!step) return instance.destroy()
      if (index > 0 && steps[index - 1]?.target === 'guardrail-list') {
        guardrailHref ??=
          document.querySelector(selector('guardrail-link'))?.getAttribute('href') ?? undefined
      }
      const route = resolve(step)
      if (!route) return go(index + direction, direction)
      if (router.state.location.pathname !== route) await router.navigate({ href: route })
      instance.moveTo(index)
    }

    const driveSteps: DriveStep[] = steps.map((step) => ({
      element: step.target ? selector(step.target) : undefined,
      popover: { title: step.title, description: step.description, side: step.side },
    }))

    tour.current = driver({
      steps: driveSteps,
      showProgress: true,
      progressText: '{{current}} / {{total}}',
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: 'Finish',
      popoverClass: 'demo-tour',
      stagePadding: 6,
      stageRadius: 10,
      waitForElement: 4000,
      disableActiveInteraction: true,
      overlayClickBehavior: () => {},
      onNextClick: (_el, _step, { index }) => {
        if (index === undefined) return
        if (index === steps.length - 1) return tour.current?.destroy()
        go(index + 1, 1)
      },
      onPrevClick: (_el, _step, { index }) => {
        if (index) go(index - 1, -1)
      },
      onDestroyed: () => {
        tour.current = null
      },
    })

    if (router.state.location.pathname !== '/') {
      router.navigate({ href: '/' }).then(() => tour.current?.drive(0))
    } else {
      tour.current.drive(0)
    }
  }, [router])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('tour') === '1') start()
    return () => tour.current?.destroy()
  }, [start])

  return (
    <Button size="sm" variant="secondary" onClick={start} data-tour="tour-button">
      <Compass /> Take the tour
    </Button>
  )
}
