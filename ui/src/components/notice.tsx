import type { JSX } from 'react';

import { Button } from './ui/button.tsx';

export type NoticeProps = {
  readonly label: string;
  readonly message: string;
  readonly onDismiss?: (() => void) | undefined;
};

/**
 * Carries the daemon's own message through unedited. It borrows the strip's rail so
 * a failure reads as part of the board rather than as an overlay on top of it.
 */
export const Notice = ({ label, message, onDismiss }: NoticeProps): JSX.Element => (
  <div className="grid grid-cols-[3px_minmax(0,1fr)]" data-state="failed" role="alert">
    <span aria-hidden="true" className="rounded-l-strip bg-signal" />
    <div className="rounded-r-strip border border-hairline border-l-0 bg-raised px-4 py-3.5">
      <p className="font-mono text-micro text-signal uppercase">{label}</p>
      <p className="mt-2 text-body break-words">{message}</p>
      {onDismiss === undefined ? null : (
        <Button className="mt-1 -ml-4" onClick={onDismiss} variant="ghost">
          Dismiss
        </Button>
      )}
    </div>
  </div>
);
