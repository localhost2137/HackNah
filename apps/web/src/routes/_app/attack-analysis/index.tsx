import { createFileRoute, redirect } from '@tanstack/react-router'

/** The dataset catalog lives on the Attack analysis page (/datasets); a run opens under /attack-analysis/<id>. */
export const Route = createFileRoute('/_app/attack-analysis/')({
  beforeLoad: () => {
    throw redirect({ to: '/datasets' })
  },
})
