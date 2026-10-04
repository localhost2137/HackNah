import type * as React from 'react'
import { cn } from './cn.ts'

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="overflow-x-auto rounded-[inherit]">
      <table className={cn('w-full border-collapse text-[13px]', className)} {...props} />
    </div>
  )
}

export function THead({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn('border-b border-line bg-bg/35', className)} {...props} />
}

export function TBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-y divide-line/70', className)} {...props} />
}

export function TR({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'transition-colors hover:bg-white/[0.025] focus-within:bg-white/[0.025]',
        props.onClick && 'cursor-pointer hover:bg-panel-2/55',
        className,
      )}
      {...props}
    />
  )
}

export function TH({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'h-10 px-5 text-left text-xs font-medium whitespace-nowrap text-muted',
        className,
      )}
      {...props}
    />
  )
}

export function TD({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('h-14 px-5 align-middle whitespace-nowrap', className)} {...props} />
}
