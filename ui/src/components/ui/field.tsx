import type { ComponentProps, JSX, ReactNode } from 'react';

import { cn } from '../../lib/utils.ts';

const CONTROL =
  'w-full rounded-control border border-hairline bg-raised px-3.5 text-ink placeholder:text-faint';

export type FieldProps = {
  readonly htmlFor: string;
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
};

/** A label, its control, and at most one line of guidance underneath it. */
export const Field = ({ children, hint, htmlFor, label }: FieldProps): JSX.Element => (
  <div className="space-y-2">
    <label className="block font-mono text-micro text-muted uppercase" htmlFor={htmlFor}>
      {label}
    </label>
    {children}
    {hint === undefined ? null : <p className="text-data text-faint">{hint}</p>}
  </div>
);

/**
 * A native select rather than a listbox: on a phone this opens the platform
 * picker, which is the one control already sized for a thumb and reachable
 * one-handed at the bottom of the screen.
 */
export const Select = ({ className, ...props }: ComponentProps<'select'>): JSX.Element => (
  <div className="relative">
    <select
      className={cn(CONTROL, 'min-h-14 appearance-none pr-11 font-mono text-body', className)}
      {...props}
    />
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-muted"
      fill="none"
      height="8"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 12 8"
      width="12"
    >
      <path d="M1 1.5 6 6.5l5-5" />
    </svg>
  </div>
);

export const Textarea = ({ className, ...props }: ComponentProps<'textarea'>): JSX.Element => (
  <textarea
    className={cn(CONTROL, 'min-h-28 resize-y py-3 text-body leading-relaxed', className)}
    {...props}
  />
);
