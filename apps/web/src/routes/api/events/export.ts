import { event, user } from '@acl/db'
import { createFileRoute } from '@tanstack/react-router'
import { desc, eq } from 'drizzle-orm'
import { audit } from '#/server/audit.ts'
import {
  csvHeader,
  EXPORT_LIMIT,
  exportFormat,
  exportLine,
  exportSelection,
} from '#/server/events-export.ts'
import { eventFilters, eventsSearch } from '#/server/fns/traffic.ts'
import { requestAdmin } from '#/server/request-admin.ts'

const PAGE = 500

const exportQuery = eventsSearch.omit({ selected: true }).extend({
  format: exportFormat.default('csv'),
})

/**
 * The Logs view as a file, newest first, with the same filters as the page: `?format=csv` or
 * `?format=jsonl`, plus `range`, `decision`, `kind`, `user`, `session`, `guardrail` and `q`.
 * Rows are streamed page by page, so a month of traffic never sits in memory at once.
 */
export const Route = createFileRoute('/api/events/export')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const who = await requestAdmin(request)
        if (!who) return Response.json({ error: 'Admins only' }, { status: 403 })
        const parsed = exportQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams))
        if (!parsed.success) return Response.json({ error: 'Invalid filters' }, { status: 400 })
        const { format, ...search } = parsed.data
        const { db, orgId } = who
        await audit(db, { orgId, actorId: who.userId, action: 'events.export', data: parsed.data })

        const encoder = new TextEncoder()
        let cursor: number | undefined
        let sent = 0
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (format === 'csv') controller.enqueue(encoder.encode(csvHeader()))
          },
          async pull(controller) {
            const limit = Math.min(PAGE, EXPORT_LIMIT - sent)
            const rows = await db
              .select(exportSelection)
              .from(event)
              .leftJoin(user, eq(user.id, event.userId))
              .where(eventFilters(orgId, { ...search, cursor }))
              .orderBy(desc(event.seq))
              .limit(limit)
            if (rows.length)
              controller.enqueue(encoder.encode(rows.map((r) => exportLine(format, r)).join('')))
            sent += rows.length
            cursor = rows.at(-1)?.seq
            if (rows.length < limit || sent >= EXPORT_LIMIT) controller.close()
          },
        })

        const day = new Date().toISOString().slice(0, 10)
        return new Response(body, {
          headers: {
            'content-type':
              format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
            'content-disposition': `attachment; filename="events-${search.range}-${day}.${format}"`,
            'cache-control': 'no-store',
          },
        })
      },
    },
  },
})
