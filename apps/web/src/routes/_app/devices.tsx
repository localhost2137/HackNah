import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/devices')({
  beforeLoad: () => {
    throw redirect({ to: '/events', search: { range: '24h' }, replace: true })
  },
})
