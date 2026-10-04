import * as DialogPrimitive from '@radix-ui/react-dialog'
import type * as React from 'react'
import { cn } from './cn.ts'

type OverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}

/** Right-hand drawer used for detail views (event details, editing). */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: OverlayProps & { wide?: boolean }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={cn(
            'ui-sheet fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-panel shadow-2xl focus:outline-none',
            wide ? 'max-w-3xl' : 'max-w-xl',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold tracking-tight text-fg">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1.5 text-[13px] leading-relaxed text-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">
                  Details
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
              aria-label="Close"
            >
              ✕
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-bg/35 px-6 py-4">
              {footer}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: OverlayProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="ui-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line-strong bg-panel shadow-2xl focus:outline-none">
          <div className="relative shrink-0 border-b border-line px-6 py-5 pr-14">
            <DialogPrimitive.Close
              className="absolute right-4 top-4 flex size-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-fg"
              aria-label="Close dialog"
            >
              ✕
            </DialogPrimitive.Close>
            <DialogPrimitive.Title className="text-base font-semibold tracking-tight text-fg">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1.5 text-[13px] leading-relaxed text-muted">
                {description}
              </DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">Dialog</DialogPrimitive.Description>
            )}
          </div>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
          {footer ? (
            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-bg/35 px-6 py-4">
              {footer}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
