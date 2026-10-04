import { MutationCache, QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const mutationCache = new MutationCache({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attack-analysis-runs'] })
    },
  })
  const queryClient = new QueryClient({
    mutationCache,
    defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } },
  })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
