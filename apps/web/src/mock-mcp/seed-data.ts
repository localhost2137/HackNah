import type { Provider } from './catalog.ts'

export type MockRecord = {
  provider: Provider
  kind: string
  id: string
  body: Record<string, unknown>
}

/** A coherent fictional bank, not invented claims about any real financial institution. */
export function buildMockRecords(anchor = Date.now()): MockRecord[] {
  const base = Math.floor(anchor / 60_000) * 60_000
  const at = (minutes: number, seconds = 0) =>
    new Date(base + minutes * 60_000 + seconds * 1000).toISOString()
  const records: MockRecord[] = []
  const add = (provider: Provider, kind: string, id: string, body: Record<string, unknown>) =>
    records.push({ provider, kind, id, body: { id, ...body } })
  const staff = {
    payments: 'Maya Chen',
    sre: 'Owen Patel',
    risk: 'Elena Novak',
    incident: 'Samira Okafor',
    platform: 'Luis Romero',
  }
  const services = [
    [
      'settlement-orchestrator',
      'Payments Engineering',
      'degraded',
      ['ledger-writer', 'sanctions-screening'],
      '4.18.0',
      0.2,
      2.1,
      240,
      8200,
    ],
    [
      'ledger-writer',
      'Ledger Platform',
      'degraded',
      ['ledger-postgres'],
      '2.9.4',
      0.03,
      0.8,
      55,
      6100,
    ],
    [
      'sanctions-screening',
      'Financial Crime Technology',
      'degraded',
      ['sanctions-feed'],
      '3.7.2',
      0.05,
      0.05,
      88,
      91,
    ],
    [
      'market-data-gateway',
      'Markets Infrastructure',
      'healthy',
      ['venue-feed'],
      '7.3.1',
      0.1,
      0.12,
      18,
      22,
    ],
    [
      'client-api',
      'Digital Channels',
      'degraded',
      ['settlement-orchestrator'],
      '5.12.0',
      0.15,
      1.9,
      320,
      8500,
    ],
    [
      'portfolio-risk',
      'Risk Analytics',
      'healthy',
      ['market-data-gateway'],
      '6.2.0',
      0.04,
      0.04,
      135,
      139,
    ],
    [
      'cash-reconciliation',
      'Finance Operations',
      'healthy',
      ['ledger-writer'],
      '1.14.2',
      0.01,
      0.01,
      440,
      450,
    ],
    ['document-vault', 'Enterprise Platforms', 'healthy', [], '2.1.6', 0.02, 0.02, 70, 72],
  ] as const
  for (const [
    name,
    team,
    health,
    dependencies,
    version,
    baselineError,
    error,
    baselineP95,
    p95,
  ] of services) {
    add('datadog', 'service', name, {
      service: name,
      team,
      health,
      env: 'prod',
      region: 'eu-west-1',
      version,
      dependencies,
      observed_at: at(0),
      sample_window: 'last 5 minutes',
      baseline_window: '30 minutes before deployment',
      metrics: {
        error_rate_pct: error,
        baseline_error_rate_pct: baselineError,
        p95_ms: p95,
        baseline_p95_ms: baselineP95,
        availability_slo_pct: 99.95,
      },
      notes:
        name === 'sanctions-screening'
          ? 'API latency is normal. Feed freshness is degraded; these are distinct signals.'
          : name === 'settlement-orchestrator'
            ? 'Improving after the retry fan-out flag was disabled, but locked work remains queued.'
            : 'Health is computed from synthetic aggregate counters; returned logs are a representative sample.',
    })
  }
  const deployments = [
    {
      id: 'baseline-4.17.3',
      service: 'settlement-orchestrator',
      version: '4.17.3',
      previous_version: '4.17.2',
      timestamp: at(-10080),
      author: staff.payments,
      rollout: 'Healthy baseline; instruction-scoped keys and serial retries.',
      config_diff: {},
    },
    {
      id: 'deploy-settlement-418',
      service: 'settlement-orchestrator',
      version: '4.18.0',
      previous_version: '4.17.3',
      timestamp: at(-75),
      completed_at: at(-72),
      author: staff.payments,
      change_issue: 'PAY-1842',
      commit: 'c7a9f02',
      config_diff: {
        retry_parallelism: { before: 1, after: 4 },
        idempotency_scope: { before: 'instruction', after: 'instruction-and-attempt' },
      },
      rollout: '10% canary for 2 minutes, then 100%',
      canary_gap:
        'Canary exercised first attempts only; replay and lock-contention traffic was absent.',
      rollback_version: '4.17.3',
      rollback_runbook: 'CONF-101',
      mitigation: {
        timestamp: at(-18),
        flag: 'settlement.parallel_retries',
        value: false,
        approver: staff.incident,
      },
    },
    {
      id: 'deploy-ledger-294',
      service: 'ledger-writer',
      version: '2.9.4',
      previous_version: '2.9.3',
      timestamp: at(-1440),
      author: staff.platform,
      change_issue: 'PLAT-321',
      config_diff: { log_sampling_pct: { before: 5, after: 10 } },
      rollout: 'Completed previous day; no schema migration.',
    },
    {
      id: 'deploy-market-731',
      service: 'market-data-gateway',
      version: '7.3.1',
      previous_version: '7.3.0',
      timestamp: at(-90),
      author: 'Nadia Brooks',
      change_issue: 'PLAT-338',
      config_diff: { reconnect_jitter_ms: { before: 50, after: 150 } },
      rollout: 'Healthy; a brief venue reconnect at T-46m recovered automatically.',
    },
    {
      id: 'deploy-settlement-staging',
      service: 'settlement-orchestrator',
      env: 'staging',
      version: '4.19.0-rc1',
      previous_version: '4.18.0',
      timestamp: at(-9),
      author: staff.payments,
      change_issue: 'PAY-1861',
      config_diff: {
        idempotency_scope: { before: 'instruction-and-attempt', after: 'instruction' },
      },
      rollout: 'Candidate fix under replay tests. Not approved for production.',
    },
  ]
  for (const d of deployments) add('datadog', 'deployment', d.id, { env: 'prod', ...d })
  const monitorData = [
    [
      'DD-4101',
      'Settlement instruction failure rate',
      'settlement-orchestrator',
      'Alert',
      2.1,
      1,
      'percent',
      'PAY-1847',
      'CONF-101',
      -67,
    ],
    [
      'DD-4102',
      'Ledger row-lock wait p95',
      'ledger-writer',
      'Alert',
      6100,
      1000,
      'milliseconds',
      'PAY-1847',
      'CONF-102',
      -68,
    ],
    [
      'DD-4103',
      'Sanctions reference feed age',
      'sanctions-screening',
      'Warn',
      74,
      60,
      'minutes',
      'RISK-932',
      'CONF-201',
      -14,
    ],
    [
      'DD-4104',
      'Venue reconnect rate',
      'market-data-gateway',
      'OK',
      0,
      5,
      'per minute',
      'PLAT-340',
      'CONF-301',
      -46,
    ],
    [
      'DD-4105',
      'Settlement backlog age',
      'settlement-orchestrator',
      'Alert',
      32,
      15,
      'minutes',
      'PAY-1847',
      'CONF-101',
      -50,
    ],
    [
      'DD-4106',
      'Portfolio valuation availability',
      'portfolio-risk',
      'OK',
      99.99,
      99.95,
      'percent',
      'RISK-910',
      'CONF-401',
      -120,
    ],
  ] as const
  for (const [
    id,
    name,
    service,
    state,
    value,
    threshold,
    unit,
    issue,
    runbook,
    started,
  ] of monitorData)
    add('datadog', 'monitor', id, {
      name,
      service,
      state,
      value,
      threshold,
      unit,
      env: 'prod',
      observed_at: at(0),
      first_triggered_at: state === 'OK' ? null : at(started),
      query: `service:${service} env:prod`,
      issue_key: issue,
      runbook_id: runbook,
      owner: service === 'sanctions-screening' ? staff.risk : staff.sre,
      history: [
        { timestamp: at(started), state: id === 'DD-4104' ? 'Warn' : state },
        { timestamp: at(id === 'DD-4104' ? -44 : -5), state },
      ],
      note:
        id === 'DD-4104'
          ? 'Recovered in 94 seconds. This warning is not evidence of a settlement dependency failure.'
          : id === 'DD-4103'
            ? 'Do not bypass screening. Unscreened instructions remain held.'
            : 'Aggregate monitor statistics cover more traffic than the sampled logs.',
    })

  // Matching request, trace, span and log identifiers; error traces are multi-service.
  for (let i = 0; i < 36; i++) {
    const failed = i >= 8 && i < 28
    const recovery = i >= 28
    const minute = i < 8 ? -100 + i * 3 : failed ? -69 + (i - 8) * 2 : -17 + (i - 28) * 2
    const traceId = `trace-settlement-${String(i + 1).padStart(3, '0')}`
    const instruction = `SYN-EUR-${String(620001 + (recovery ? i - 20 : i)).padStart(6, '0')}`
    const requestId = `req-${traceId}`
    const duration = failed ? 46200 : 180 + i * 3
    const span = (
      id: string,
      parent: string | null,
      service: string,
      operation: string,
      start: number,
      ms: number,
      error = false,
    ) => ({
      span_id: id,
      parent_id: parent,
      service,
      operation,
      start_offset_ms: start,
      duration_ms: ms,
      error,
    })
    const spans = failed
      ? [
          span('root', null, 'client-api', 'POST /v1/settlements', 0, duration, true),
          span(
            'orchestrate',
            'root',
            'settlement-orchestrator',
            'settle_instruction',
            3,
            46190,
            true,
          ),
          span('screen', 'orchestrate', 'sanctions-screening', 'screen_party', 6, 85),
          span('attempt-1', 'orchestrate', 'ledger-writer', 'post_journal', 100, 15000, true),
          span('attempt-2', 'orchestrate', 'ledger-writer', 'post_journal', 15150, 15000, true),
          span('attempt-3', 'orchestrate', 'ledger-writer', 'post_journal', 30200, 15000, true),
        ]
      : [
          span('root', null, 'client-api', 'POST /v1/settlements', 0, duration),
          span(
            'orchestrate',
            'root',
            'settlement-orchestrator',
            'settle_instruction',
            3,
            duration - 6,
          ),
          span('screen', 'orchestrate', 'sanctions-screening', 'screen_party', 7, 70),
          span('journal', 'orchestrate', 'ledger-writer', 'post_journal', 80, 65),
        ]
    const events = failed
      ? [
          {
            service: 'settlement-orchestrator',
            status: 'info',
            offset: 0,
            span_id: 'orchestrate',
            message: 'Settlement accepted for processing',
            attributes: {
              instruction_id: instruction,
              request_id: requestId,
              attempt: 1,
              version: '4.18.0',
              deployment_id: 'deploy-settlement-418',
            },
          },
          {
            service: 'sanctions-screening',
            status: 'info',
            offset: 0.09,
            span_id: 'screen',
            message: 'Screening completed: CLEAR',
            attributes: {
              instruction_id: instruction,
              decision: 'CLEAR',
              feed_snapshot: `SAN-${new Date(base).toISOString().slice(0, 10)}-A`,
              duration_ms: 85,
            },
          },
          {
            service: 'ledger-writer',
            status: 'error',
            offset: 15.1,
            span_id: 'attempt-1',
            message: 'Journal row lock timeout; transaction rolled back',
            attributes: {
              instruction_id: instruction,
              sqlstate: '55P03',
              lock_wait_ms: 15000,
              attempt: 1,
              idempotency_key: `${instruction}:attempt-1`,
              lock_owner: `retry-worker-${i % 4}`,
            },
          },
          {
            service: 'ledger-writer',
            status: 'error',
            offset: 30.15,
            span_id: 'attempt-2',
            message:
              'Retry competed for the same instruction lock with a different idempotency key',
            attributes: {
              instruction_id: instruction,
              sqlstate: '55P03',
              lock_wait_ms: 15000,
              attempt: 2,
              idempotency_key: `${instruction}:attempt-2`,
              retry_parallelism: 4,
            },
          },
          {
            service: 'client-api',
            status: 'error',
            offset: 46.2,
            span_id: 'root',
            message: 'Settlement timed out; status PENDING_RETRY, no final booking acknowledged',
            attributes: {
              instruction_id: instruction,
              http_status: 504,
              duration_ms: duration,
              issue_key: 'PAY-1847',
              sensitive_fields: 'Client name and account number omitted from telemetry',
            },
          },
        ]
      : [
          {
            service: 'settlement-orchestrator',
            status: 'info',
            offset: 0,
            span_id: 'orchestrate',
            message: recovery
              ? 'Serialized retry completed after mitigation'
              : 'Settlement instruction processed normally',
            attributes: {
              instruction_id: instruction,
              version: recovery ? '4.18.0' : '4.17.3',
              idempotency_key: instruction,
              retry_parallelism: 1,
            },
          },
          {
            service: 'ledger-writer',
            status: 'info',
            offset: 0.08,
            span_id: 'journal',
            message: 'Balanced journal committed; debit equals credit',
            attributes: {
              instruction_id: instruction,
              currency: 'EUR',
              amount_minor: 1250000 + i * 37500,
              journal_id: `JRN-SYN-${i}`,
              duplicate_booking: false,
            },
          },
          {
            service: 'client-api',
            status: 'info',
            offset: duration / 1000,
            span_id: 'root',
            message: 'Settlement acknowledged',
            attributes: { instruction_id: instruction, http_status: 201, duration_ms: duration },
          },
        ]
    const logIds: string[] = []
    events.forEach((e, j) => {
      const id = `log-settle-${i + 1}-${j + 1}`
      logIds.push(id)
      add('datadog', 'log', id, {
        timestamp: at(minute, e.offset),
        trace_id: traceId,
        env: 'prod',
        region: 'eu-west-1',
        team: 'Payments Engineering',
        ...e,
      })
    })
    add('datadog', 'trace', traceId, {
      trace_id: traceId,
      request_id: requestId,
      instruction_id: instruction,
      service: 'settlement-orchestrator',
      env: 'prod',
      timestamp: at(minute),
      duration_ms: duration,
      status: failed ? 'error' : 'ok',
      deployment_id: i < 8 ? 'baseline-4.17.3' : 'deploy-settlement-418',
      spans,
      log_ids: logIds,
      related_issue: failed ? 'PAY-1847' : null,
    })
  }
  for (let i = 0; i < 180; i++) {
    const service = [
      'market-data-gateway',
      'portfolio-risk',
      'cash-reconciliation',
      'document-vault',
    ][i % 4]!
    const minute = -119 + (i % 120)
    add('datadog', 'log', `log-background-${i}`, {
      timestamp: at(minute, i % 59),
      service,
      status: 'info',
      env: i % 13 === 0 ? 'staging' : 'prod',
      region: i % 3 === 0 ? 'us-east-1' : 'eu-west-1',
      message:
        service === 'market-data-gateway'
          ? 'Venue heartbeat healthy; sequence gap zero'
          : service === 'portfolio-risk'
            ? 'Intraday exposure recalculation completed within SLO'
            : service === 'cash-reconciliation'
              ? 'Ledger control totals reconciled; no unexplained difference'
              : 'Document retrieval completed',
      attributes: {
        duration_ms: 15 + ((i * 17) % 180),
        batch_id: `SYN-BATCH-${i}`,
        records_processed: 100 + i * 7,
      },
    })
  }
  const specialLogs = [
    [
      'log-deploy',
      'settlement-orchestrator',
      'info',
      -72,
      'Deployment 4.18.0 reached 100%; parallel retry flag enabled',
      { deployment_id: 'deploy-settlement-418', change_issue: 'PAY-1842' },
    ],
    [
      'log-flag-off',
      'settlement-orchestrator',
      'warn',
      -18,
      'Incident mitigation: parallel retry flag disabled; backlog replay remains paused',
      { actor: staff.sre, approved_by: staff.incident, issue_key: 'PAY-1847' },
    ],
    [
      'log-backlog',
      'settlement-orchestrator',
      'warn',
      -3,
      'Backlog drain slower than target; 187 instructions still delayed',
      {
        oldest_age_minutes: 32,
        delayed_instructions: 187,
        synthetic_notional_eur: 48200000,
        duplicate_bookings_detected: 0,
      },
    ],
    [
      'log-feed-fail',
      'sanctions-screening',
      'error',
      -59,
      'Reference-data poll failed: upstream client certificate expired',
      {
        endpoint: 'https://sanctions-feed.aurelius.example/snapshots',
        certificate_serial: 'SYN-CERT-0007',
        http_status: 495,
        issue_key: 'RISK-932',
      },
    ],
    [
      'log-feed-stale',
      'sanctions-screening',
      'warn',
      -14,
      'Reference feed age crossed 60 minutes; new unscreened parties are held',
      { feed_age_minutes: 60, hold_policy: 'fail-closed', runbook_id: 'CONF-201' },
    ],
    [
      'log-feed-current',
      'sanctions-screening',
      'warn',
      -1,
      'Reference feed remains stale; existing screened instructions unaffected',
      { feed_age_minutes: 73, held_new_parties: 12, screening_bypass: false },
    ],
    [
      'log-venue-warn',
      'market-data-gateway',
      'warn',
      -46,
      'Venue heartbeat missed during reconnect',
      { venue: 'SYN-XEUR', reconnects: 1, issue_key: 'PLAT-340' },
    ],
    [
      'log-venue-ok',
      'market-data-gateway',
      'info',
      -44.433333,
      'Venue subscription restored; sequence replay complete',
      { venue: 'SYN-XEUR', recovery_seconds: 94, lost_ticks: 0 },
    ],
    [
      'log-control',
      'cash-reconciliation',
      'info',
      -2,
      'Incident control check: no duplicate postings found',
      { control: 'CTRL-SETTLE-017', issue_key: 'PAY-1847', unexplained_difference_minor: 0 },
    ],
  ] as const
  for (const [id, service, status, time, message, attributes] of specialLogs)
    add('datadog', 'log', id, {
      timestamp: at(time),
      service,
      status,
      env: 'prod',
      region: 'eu-west-1',
      message,
      attributes,
    })

  const pages = [
    [
      'CONF-100',
      'PAY',
      'Settlement platform: dependency map',
      'Payments Engineering',
      'current',
      ['settlement', 'architecture', 'ownership'],
      `# Settlement platform\n\nAurelius Securities processes synthetic institutional EUR and USD payment instructions. Client API authenticates the caller, settlement-orchestrator assigns an instruction ID, sanctions-screening returns a decision, and ledger-writer commits a balanced journal. cash-reconciliation verifies control totals independently.\n\n## Dependency boundaries\nMarket-data-gateway and portfolio-risk are NOT synchronous dependencies of settlement booking. An alert in Markets must not be used as the explanation for a Payments outage without trace evidence. Screening API availability and freshness of its reference feed are different signals.\n\n## Ownership\nPayments: Maya Chen. Ledger Platform: Luis Romero. Incident command: Samira Okafor. Primary on-call: Owen Patel.\n\n## Identifiers\nSearch Datadog by instruction_id text or trace_id facet. An instruction can have multiple requests, but must have one stable idempotency key. Retrieve traces before concluding that a client timeout means a booking failed.\n\nSee CONF-101 for incident response, CONF-102 for idempotency and CONF-201 for screening holds.`,
      ['CONF-101', 'CONF-102', 'CONF-201'],
      ['PAY-1847'],
    ],
    [
      'CONF-101',
      'PAY',
      'Runbook: settlement timeout and growing backlog',
      'Owen Patel',
      'current',
      ['settlement', 'runbook', 'timeout', 'rollback'],
      `# Settlement timeout / backlog response\n\n## Trigger\nDD-4101 exceeds 1% errors or DD-4105 oldest instruction age exceeds 15 minutes. Current incident: PAY-1847.\n\n## Diagnose before acting\n1. Compare failures against deployments and the last healthy version.\n2. Fetch at least one failing trace and one successful pre-deployment trace.\n3. If ledger spans return SQLSTATE 55P03, compare idempotency keys across retry attempts and inspect retry_parallelism.\n4. Check CONF-201 separately if screening is actually rejecting or holding the instruction. A stale feed warning alone does not prove it caused ledger lock waits.\n\n## Containment\nIncident command may authorize disabling settlement.parallel_retries. This has already happened at T-18m in the seeded drill. Do not claim the incident is resolved merely because error rate falls. Reconcile pending instructions and verify the oldest backlog age.\n\n## Rollback gate\nValidate schema compatibility and obtain incident-command approval before returning to 4.17.3. Never replay the entire queue blindly; reconcile instruction IDs with committed journals first. This mock exposes no rollback or replay tool.\n\n## Recovery criteria\nError rate below 0.5% for 15 continuous minutes, oldest pending instruction below 5 minutes, zero unexplained reconciliation difference, and Finance Operations sign-off.\n\n## Evidence to attach\nDeployment ID, trace IDs, monitor windows, mitigation timestamp and CTRL-SETTLE-017 result. Follow-up implementation is PAY-1861.`,
      ['CONF-100', 'CONF-102', 'CONF-103'],
      ['PAY-1847', 'PAY-1861'],
    ],
    [
      'CONF-102',
      'PAY',
      'ADR-027: instruction-scoped idempotency',
      'Luis Romero',
      'current',
      ['ledger', 'idempotency', '55P03'],
      `# ADR-027: instruction-scoped idempotency\n\nStatus: Accepted. The idempotency identity is the immutable settlement instruction ID, not the HTTP request ID and not the retry attempt.\n\n## Invariants\nOne instruction produces at most one balanced journal. Retries must use the original key. A timeout is an unknown outcome until the journal is checked. Different keys for attempts can bypass deduplication while still contending on the same instruction row. Database uniqueness prevents some duplicate commits, but does not prevent a retry storm.\n\n## Failure signature\nRepeated SQLSTATE 55P03, 15000ms lock waits, and keys like SYN-EUR-620009:attempt-1 followed by :attempt-2 indicate violation of this ADR. Compare this with baseline keys containing only SYN-EUR-620001.\n\n## Required tests\nConcurrent replay of the same instruction, timeout after commit, dropped acknowledgment, process restart between attempts, and reconciliation after rollback. The canary must include replay traffic.\n\nPAY-1842 changed the retry implementation. PAY-1861 restores the invariant and adds the missing concurrency regression.`,
      ['CONF-101'],
      ['PAY-1842', 'PAY-1861'],
    ],
    [
      'CONF-103',
      'PAY',
      'Archived: bulk retry procedure for settlement v3',
      'Payments Engineering',
      'superseded',
      ['settlement', 'retry', 'legacy'],
      `# Archived procedure — DO NOT use for v4\n\nThis document applied to the retired v3 single-worker settlement queue. It recommended restarting the worker and replaying the backlog after a transient timeout.\n\nThe v4 platform has concurrent workers and separate journal acknowledgments. Unconditional replay can amplify lock contention or produce ambiguous outcomes. This page is intentionally retained for historical search results and is superseded by CONF-101 and ADR-027 (CONF-102).\n\nBefore diagnosing any incident, verify the deployed major version. Current mock production is 4.18.0.`,
      ['CONF-101', 'CONF-102'],
      ['PAY-1703'],
    ],
    [
      'CONF-201',
      'RISK',
      'Runbook: stale sanctions reference feed',
      'Elena Novak',
      'current',
      ['sanctions', 'certificate', 'feed', 'runbook'],
      `# Stale sanctions reference feed\n\n## Signals\nDD-4103 monitors snapshot age, not request latency. A stale feed can coexist with a healthy screening API. Distinguish existing instructions screened against a valid snapshot from new parties requiring a fresh screening decision.\n\n## Policy\nAt age >60 minutes, hold new unscreened parties. Never disable screening or turn fail-closed into fail-open to clear a backlog. Existing cleared instructions may continue according to the signed policy snapshot.\n\n## Diagnose\nCheck the poller response, upstream certificate expiry and the most recent successfully loaded snapshot. For HTTP 495, validate the client certificate chain and renewal delivery, then involve Identity Platform.\n\n## Recovery\nAn authorized operator rotates the certificate, verifies a signed reference snapshot, and reconciles the held-party list with Financial Crime Operations. Two successful refreshes five minutes apart are required before clearing the alert. The mock has no certificate rotation or screening bypass tool.\n\nRelated RISK-932 tracks certificate renewal. This is independent of the settlement retry-key regression in PAY-1847.`,
      ['CONF-202', 'CONF-100'],
      ['RISK-932'],
    ],
    [
      'CONF-202',
      'RISK',
      'Reference data freshness and settlement cutoffs',
      'Financial Crime Operations',
      'current',
      ['sanctions', 'cutoff', 'policy'],
      `# Freshness and cutoff policy\n\nReference snapshots refresh every 15 minutes. Warn after 60 minutes; hold new unscreened parties until the feed is trustworthy. Never equate clearing a monitoring alert with authorization to release held instructions.\n\nSynthetic settlement windows: EUR 16:00 UTC, USD 21:00 UTC. These are fictional drill values, not instructions for a real payment scheme. Escalate predicted cutoff breaches to Treasury Operations with instruction counts, currencies and oldest age.\n\nUse aggregate counts in incident tickets. Client names, account numbers and beneficial-owner data do not belong in general engineering tickets. Use synthetic instruction IDs to cross-reference evidence.`,
      ['CONF-201', 'CONF-501'],
      ['RISK-932'],
    ],
    [
      'CONF-301',
      'PLAT',
      'Market data reconnect: distinguish a transient from an outage',
      'Nadia Brooks',
      'current',
      ['market', 'venue', 'reconnect'],
      `# Market data reconnect runbook\n\nA transient reconnect is expected during venue maintenance. Inspect the paired recovery event, sequence continuity, dropped ticks and downstream stale-price counters.\n\nAt T-46m in this drill, SYN-XEUR missed a heartbeat. It recovered in 94 seconds with zero lost ticks. PLAT-340 is resolved. Portfolio valuation availability remains 99.99%.\n\nDo not restart unrelated payment services in response. The dependency map in CONF-100 shows that market-data-gateway is not on the synchronous settlement path. Escalate only if sequence gaps persist or portfolio-risk consumes stale prices beyond its tolerance.`,
      ['CONF-100', 'CONF-401'],
      ['PLAT-340'],
    ],
    [
      'CONF-401',
      'RISK',
      'Intraday risk: healthy baseline and escalation thresholds',
      'Risk Analytics',
      'current',
      ['risk', 'valuation', 'baseline'],
      `# Intraday risk baseline\n\nportfolio-risk computes synthetic exposure every minute using market-data-gateway. Normal p95 is 135–160ms and availability target is 99.95%. Its current p95 is 139ms.\n\nDaily batch growth can increase volume without increasing error rate. Always compare like-for-like windows and separate staging from prod.\n\nRISK-910 recorded an old, resolved stale-price issue; it is included as historical context, not evidence of a current incident. A broad search for risk errors must not treat resolved historical tickets as live alarms.`,
      ['CONF-301'],
      ['RISK-910'],
    ],
    [
      'CONF-501',
      'OPS',
      'Incident evidence, communication and approval checklist',
      'Samira Okafor',
      'current',
      ['incident', 'evidence', 'communications'],
      `# Incident handling\n\nDeclare impact using observed evidence. Distinguish delayed instructions from lost funds and duplicate bookings from duplicate retries. For PAY-1847 there are delayed instructions; the latest reconciliation has found no duplicate postings. Do not claim that funds were lost.\n\n## Investigation output\nState the observation window, affected services, likely trigger, supporting traces, competing hypotheses, mitigation already taken and remaining uncertainty. Cite page IDs and issue keys so another engineer can check the evidence.\n\n## Actions\nReading logs and docs is investigation. Creating a follow-up ticket writes to the system of record. Deployments, queue replay and data exports require their own controls; this mock does not expose those actions.\n\n## Updates\nCustomer-facing language must be approved by incident command. A ticket created by the shared integration is attributed to the integration bot, while the gateway audit records the employee who invoked it.`,
      ['CONF-101', 'CONF-202'],
      ['PAY-1847'],
    ],
    [
      'CONF-601',
      'PLAT',
      'Service ownership and telemetry conventions',
      'Enterprise Platforms',
      'current',
      ['ownership', 'datadog', 'observability'],
      `# Telemetry conventions\n\nAll fixtures belong to the fictional Aurelius Securities. No real credentials, clients, balances or incidents are represented.\n\nUse service and env facets to narrow queries. Logs are a representative sample; do not calculate production error rates from the returned page. get_service_health and list_monitors carry aggregate synthetic metrics with observation windows. All timestamps are anchored to the first successful development seed and remain stable on rerun.\n\nRegions: eu-west-1 is the Payments primary; us-east-1 is a secondary Markets region. Staging events deliberately coexist with production events to exercise filtering.\n\nOwnership: Payments Engineering (Maya Chen), Ledger Platform (Luis Romero), Financial Crime Technology (Elena Novak), SRE (Owen Patel), incident command (Samira Okafor). Use get_environment to find the dataset clock before applying time filters.`,
      ['CONF-100', 'CONF-501'],
      ['PLAT-355'],
    ],
  ] as const
  for (const [id, space, title, owner, status, labels, body, relatedPages, issues] of pages)
    add('confluence', 'page', id, {
      title,
      space,
      owner,
      status,
      labels,
      version: status === 'superseded' ? 3 : 7,
      updated_at: at(-10080),
      reviewed_at: status === 'superseded' ? at(-525600) : at(-2880),
      url: `https://confluence.aurelius.example/pages/${id}`,
      body,
      related_page_ids: relatedPages,
      issue_keys: issues,
    })

  const issues = [
    [
      'PAY-1847',
      'PAY',
      'P1',
      'Mitigating',
      'Settlement timeouts after 4.18.0 rollout',
      'Maya Chen',
      -66,
      `187 EUR instructions remain delayed; synthetic notional EUR 48.2m. Peak error rate 18.6%, current five-minute rate 2.1%. No duplicate postings observed in CTRL-SETTLE-017. Root-cause hypothesis: attempt-scoped idempotency and parallel retries introduced by deploy-settlement-418 cause ledger lock contention. Mitigation disabled parallel retries at T-18m. Recovery gates are not met.`,
      ['CONF-101', 'CONF-102', 'CONF-501'],
      ['PAY-1842', 'PAY-1861', 'RISK-932'],
      [
        [
          staff.sre,
          -64,
          'DD-4102 shows 15s row-lock waits. Database CPU is 42%, connections are below the cap; broad database overload is not supported. Inspect trace-settlement-009 and trace-settlement-012.',
        ],
        [
          staff.risk,
          -48,
          'Screening spans in the failing payment traces return CLEAR in 85ms. The stale reference-feed issue RISK-932 is real but separate; new unscreened parties are held.',
        ],
        [
          staff.payments,
          -35,
          'Baseline trace-settlement-001 uses the instruction ID as its key. Failing attempts append attempt-1 and attempt-2. That violates ADR-027. Canary did not include replay traffic.',
        ],
        [
          staff.incident,
          -18,
          'Approved disabling parallel retries. Do not bulk replay. Reconcile first; rollback requires the CONF-101 gate.',
        ],
        [
          'Finance Operations',
          -2,
          'No unexplained control-total difference. Zero duplicate journals found so far. 187 instructions still delayed; do not mark this resolved.',
        ],
      ],
    ],
    [
      'PAY-1842',
      'PAY',
      'P2',
      'Done',
      'Release 4.18.0: parallel settlement retries',
      'Maya Chen',
      -4320,
      'Increase retry concurrency from 1 to 4 and introduce attempt-specific retry tracking. Release checklist marked canary healthy; replay traffic was not represented. Deployed at T-75m. Reopened follow-up is PAY-1861.',
      ['CONF-102'],
      ['PAY-1847', 'PAY-1861'],
      [[staff.platform, -74, 'Deployment complete. No ledger schema change in this release.']],
    ],
    [
      'PAY-1861',
      'PAY',
      'P1',
      'Open',
      'Restore instruction-scoped idempotency and replay canary coverage',
      'Maya Chen',
      -29,
      'Acceptance: all retries retain one instruction key; concurrent duplicate requests produce one journal; timeout-after-commit test passes; canary includes replay traffic. Candidate 4.19.0-rc1 is in staging, not production.',
      ['CONF-102'],
      ['PAY-1847'],
      [
        [
          staff.payments,
          -9,
          'Staging candidate deployed. Waiting on concurrent replay and timeout-after-commit results. Do not call this fixed in production.',
        ],
      ],
    ],
    [
      'RISK-932',
      'RISK',
      'P2',
      'Investigating',
      'Sanctions feed refresh blocked by expired client certificate',
      'Elena Novak',
      -14,
      'Snapshot age is 74 minutes. Poller returned HTTP 495 at T-59m. Twelve new parties are held under fail-closed policy. Existing cleared settlement instructions are not held by this condition.',
      ['CONF-201', 'CONF-202'],
      ['PAY-1847', 'PLAT-355'],
      [
        [
          staff.risk,
          -12,
          'Certificate renewal succeeded in staging but its prod secret delivery was missed. Identity Platform is investigating. Screening bypass is not approved.',
        ],
      ],
    ],
    [
      'PLAT-340',
      'PLAT',
      'P3',
      'Resolved',
      'SYN-XEUR reconnect recovered with complete sequence replay',
      'Nadia Brooks',
      -46,
      'Single venue reconnect recovered in 94 seconds. Zero lost ticks, no stale prices downstream. Closed after observing the recovery event.',
      ['CONF-301'],
      ['PLAT-338'],
      [
        [
          'Nadia Brooks',
          -42,
          'Resolved. Not a dependency of settlement-orchestrator; no evidence linking this to PAY-1847.',
        ],
      ],
    ],
    [
      'PLAT-338',
      'PLAT',
      'P3',
      'Done',
      'Add reconnect jitter to market data gateway',
      'Nadia Brooks',
      -2880,
      'Release 7.3.1 increases reconnect jitter from 50ms to 150ms. Healthy rollout, no increase in tick loss.',
      ['CONF-301'],
      ['PLAT-340'],
      [],
    ],
    [
      'PLAT-321',
      'PLAT',
      'P3',
      'Done',
      'Increase ledger log sampling for incident investigations',
      'Luis Romero',
      -2880,
      'Release 2.9.4 raises sampling from 5% to 10%. No transaction, schema or lock configuration changes.',
      ['CONF-601'],
      [],
      [],
    ],
    [
      'PLAT-355',
      'PLAT',
      'P2',
      'Open',
      'Alert on certificate renewal delivery failure',
      'Luis Romero',
      -8,
      'Distinguish certificate issuance success from delivery to production workloads. Add expiry probes on the active mounted certificate and a renewal delivery SLO.',
      ['CONF-201', 'CONF-601'],
      ['RISK-932'],
      [
        [
          staff.platform,
          -5,
          'Track issued serial versus mounted serial. A green renewal job alone is insufficient evidence.',
        ],
      ],
    ],
    [
      'PAY-1703',
      'PAY',
      'P2',
      'Resolved',
      'Historical v3 worker stall after network interruption',
      'Owen Patel',
      -43200,
      'Resolved on the retired v3 queue by restarting its single worker. This remedy is NOT safe for the concurrent v4 platform.',
      ['CONF-103'],
      [],
      [[staff.sre, -43100, 'Archived. Use CONF-101 for current incidents.']],
    ],
    [
      'RISK-910',
      'RISK',
      'P2',
      'Resolved',
      'Historical stale-price warning during venue maintenance',
      'Elena Novak',
      -20160,
      'Old venue maintenance event. No current valuation SLO breach. Retained to test distinguishing historical tickets from active incidents.',
      ['CONF-401'],
      [],
      [],
    ],
  ] as const
  for (const [
    key,
    project,
    priority,
    status,
    summary,
    assignee,
    created,
    description,
    pageIds,
    related,
    comments,
  ] of issues)
    add('jira', 'issue', key, {
      key,
      project,
      priority,
      status,
      summary,
      assignee,
      reporter: 'Aurelius incident automation',
      created_at: at(created),
      updated_at: at(comments.length ? comments[comments.length - 1]![1] : created),
      description,
      labels: [
        'synthetic',
        project === 'PAY' ? 'settlement' : project === 'RISK' ? 'risk' : 'platform',
      ],
      page_ids: pageIds,
      related_issue_keys: related,
      url: `https://jira.aurelius.example/browse/${key}`,
      comments: comments.map(([author, time, body], i) => ({
        id: `${key}-comment-${i + 1}`,
        author,
        timestamp: at(time),
        body,
      })),
    })
  for (const provider of ['datadog', 'confluence', 'jira'] as const)
    add(provider, 'meta', 'environment', {
      company: 'Aurelius Securities (fictional)',
      synthetic: true,
      seed_version: 1,
      dataset_as_of: at(0),
      timezone: 'UTC',
      scenario:
        'Institutional settlement degradation with a concurrent reference-data incident and an unrelated recovered market-data warning.',
      active_issue_keys: ['PAY-1847', 'RISK-932'],
      services: services.map((s) => s[0]),
      time_range: { from: at(-120), to: at(0) },
      notes: [
        'All people, customers, monetary amounts and incidents are synthetic.',
        'Timestamps are frozen at initial seed; use this clock for time filters.',
        'Logs are samples; monitor metrics represent synthetic aggregate windows.',
        'No real provider is contacted. Tool schemas are mock-specific, not vendor API compatibility guarantees.',
      ],
    })
  return records
}
