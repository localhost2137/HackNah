import { cn } from '@acl/ui'

/** Original vector wordmark, shared by the sidebar and sign-in screens. */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src="/brand/hacknah.svg"
      alt="Hack?Nah!"
      width={310}
      height={76}
      draggable={false}
      className={cn('block h-auto shrink-0 select-none', className)}
    />
  )
}
