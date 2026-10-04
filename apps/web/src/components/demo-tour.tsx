import { Button } from '@acl/ui'
import { useRouter } from '@tanstack/react-router'
import { type Driver, type DriveStep, driver } from 'driver.js'
import { Compass } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'

type TourStep = {
  id?: string
  /** Page the step lives on; a function resolves it at runtime and `undefined` skips the step. */
  route: string | (() => string | undefined)
  /** `[data-tour="…"]` target; without one the popover is centered on the page. */
  target?: string
  title: string
  description: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  /**
   * Makes the step interactive: the judge does it on the highlighted element, and the tour moves
   * on once `done` holds, or back a step once `undone` does. Called when the step is shown.
   */
  watch?: () => { done: () => boolean; undone?: () => boolean }
  /** Where Skip leads on an interactive step. */
  skipTo?: string
  /** Where Back leads, when not the previous step. */
  backTo?: string
}

const DEMO_GUARDRAIL = 'wf_tool_calls'

const selector = (target: string) => `[data-tour="${target}"]`
const present = (target: string) => () => document.querySelector(selector(target)) !== null

/** Holds once the target shows up after having been absent, so going Back does not skip ahead. */
function appears(target: string) {
  const shown = present(target)
  let absent = !shown()
  return () => {
    if (!shown()) absent = true
    return absent && shown()
  }
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
      route: '/approvals',
      target: 'approvals-list',
      side: 'bottom',
      title: 'Human approvals',
      description:
        'A guardrail can pause a risky action until an admin approves or declines it here. Each pending request shows a countdown, and unanswered requests are declined when it runs out. <b>History</b> lists past decisions.',
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
        'A guardrail is a flowchart. A request enters at <b>Start</b>, passes through checks (prompt-injection detectors, data-leak scanners, allow-lists, ML classifiers…) and ends in a decision.<br><br>Now try it yourself. Nothing you change here is saved.',
    },
    {
      id: 'add-step',
      route: guardrailHref,
      target: 'guardrail-add-step',
      side: 'bottom',
      title: 'Try it: add a step',
      description: 'Click <b>Add step</b> to insert a new check right after <b>Start</b>.',
      watch: () => ({ done: appears('guardrail-step-picker') }),
      skipTo: 'impact',
    },
    {
      route: guardrailHref,
      target: 'guardrail-step-picker',
      side: 'right',
      title: 'Pick a check',
      description:
        'Suggested steps come first, based on what this guardrail already does. Pick one, for example <b>Keyword match</b>. <b>Other elements</b> lists everything else.',
      watch: () => ({
        done: present('guardrail-panel'),
        undone: () => !present('guardrail-step-picker')() && !present('guardrail-panel')(),
      }),
      skipTo: 'impact',
    },
    {
      route: guardrailHref,
      target: 'guardrail-panel',
      side: 'left',
      title: 'Configure it',
      description:
        'The new step is wired into the flow and selected. Its settings are here: patterns, thresholds, and where each outcome leads. Anything left to fix is marked in red.',
      backTo: 'add-step',
    },
    {
      id: 'test',
      route: guardrailHref,
      target: 'guardrail-test',
      side: 'bottom',
      title: 'Try it: test a request',
      description:
        'Click <b>Test request</b> to dry-run a request through this flowchart, without sending anything.',
      watch: () => ({ done: appears('dry-run') }),
      skipTo: 'impact',
    },
    {
      route: guardrailHref,
      target: 'guardrail-panel',
      side: 'left',
      title: 'Run a dangerous command',
      description:
        'The form is prefilled with a harmless Bash tool call. Replace the arguments with <code>{"command":"git push --force"}</code> and click <b>Run</b>.',
      watch: () => ({ done: present('dry-run-result') }),
      skipTo: 'impact',
      backTo: 'test',
    },
    {
      route: guardrailHref,
      target: 'guardrail-panel',
      side: 'left',
      title: 'See why',
      description:
        'The badge is the decision. Below it, every check on the path says whether it passed and why, and the path the request took is highlighted in the flowchart. Try other arguments and run again.',
      backTo: 'test',
    },
    {
      id: 'impact',
      route: guardrailHref,
      target: 'guardrail-impact',
      side: 'bottom',
      title: 'Impact on past traffic',
      description:
        'Before publishing, <b>Impact</b> replays recent real traffic against the draft and shows which past requests would now be blocked or allowed. Publishing creates a new version you can roll back.<br><br>Your edits only live in this tab and are discarded when you leave the page. On this shared demo, please don’t click <b>Save draft</b> or <b>Publish</b>.',
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

export function DemoTourButton() {
  const router = useRouter()
  const tour = useRef<Driver | null>(null)

  const start = useCallback(() => {
    tour.current?.destroy()
    let guardrailHref: string | undefined
    const steps = buildSteps(() => guardrailHref)

    const resolve = (step: TourStep) =>
      typeof step.route === 'function' ? step.route() : step.route
    const indexOf = (id: string | undefined) => steps.findIndex((s) => id && s.id === id)

    let stopWatching = () => {}

    const go = async (index: number, direction: 1 | -1) => {
      stopWatching()
      const instance = tour.current
      if (!instance) return
      const step = steps[index]
      if (!step) return instance.destroy()
      if (index > 0 && steps[index - 1]?.target === 'guardrail-list') {
        guardrailHref ??=
          (
            document.querySelector(`a[href="/guardrails/${DEMO_GUARDRAIL}"]`) ??
            document.querySelector(selector('guardrail-link'))
          )?.getAttribute('href') ?? undefined
      }
      const route = resolve(step)
      if (!route) return go(index + direction, direction)
      if (router.state.location.pathname !== route) await router.navigate({ href: route })
      instance.moveTo(index)
    }

    const watch = (index: number) => {
      stopWatching()
      const check = steps[index]?.watch?.()
      if (!check) return
      const test = () => {
        if (check.done()) go(index + 1, 1)
        else if (check.undone?.()) go(index - 1, -1)
      }
      const observer = new MutationObserver(test)
      observer.observe(document.body, { childList: true, subtree: true })
      stopWatching = () => observer.disconnect()
      test()
    }

    const driveSteps: DriveStep[] = steps.map((step) => ({
      element: step.target ? selector(step.target) : undefined,
      disableActiveInteraction: !step.watch,
      popover: {
        title: step.title,
        description: step.description,
        side: step.side,
        nextBtnText: step.watch ? 'Skip' : undefined,
      },
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
      onHighlighted: (_el, _step, { index, driver: instance }) => {
        if (index === undefined) return
        // Arrow keys and Escape would otherwise move the tour while the judge types in a form.
        instance.setConfig({ ...instance.getConfig(), allowKeyboardControl: !steps[index]?.watch })
        watch(index)
      },
      onNextClick: (_el, _step, { index }) => {
        if (index === undefined) return
        if (index === steps.length - 1) return tour.current?.destroy()
        const skip = steps[index]?.watch ? indexOf(steps[index]?.skipTo) : -1
        go(skip >= 0 ? skip : index + 1, 1)
      },
      onPrevClick: (_el, _step, { index }) => {
        if (!index) return
        const back = indexOf(steps[index]?.backTo)
        go(back >= 0 ? back : index - 1, -1)
      },
      onDestroyed: () => {
        stopWatching()
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
