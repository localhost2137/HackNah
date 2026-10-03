import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

// Compatibility for old sign-up links; there is no tenant setup step.
export const Route = createFileRoute('/onboarding')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: ({ search }) => {
    const target = search.redirect
    throw redirect({
      href:
        target?.startsWith('/') && !target.startsWith('//') && !target.startsWith('/onboarding')
          ? target
          : '/',
    })
  },
})
