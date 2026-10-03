import { createFileRoute } from '@tanstack/react-router'
import { createAuth } from '#/server/auth.ts'
import { getDb } from '#/server/env.ts'

const handle = ({ request }: { request: Request }) => createAuth(getDb()).handler(request)

export const Route = createFileRoute('/api/auth/$')({
  server: { handlers: { GET: handle, POST: handle } },
})
