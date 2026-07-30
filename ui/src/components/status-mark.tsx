import type { JSX } from 'react';

import type { BoardState } from '../lib/board-state.ts';
import { cn } from '../lib/utils.ts';

/**
 * A distinct glyph per state, so the board is still readable to an operator who
 * cannot tell the rail colours apart: a ring waits, a filled disc works, a target
 * is live but silent, a square is shut down, a cross failed.
 */
const GLYPHS: Readonly<Record<BoardState, JSX.Element>> = {
  busy: <circle cx="5" cy="5" fill="currentColor" r="4" />,
  failed: <path d="M1.8 1.8 8.2 8.2M8.2 1.8 1.8 8.2" strokeWidth="1.8" />,
  idle: <circle cx="5" cy="5" r="3.4" strokeWidth="1.6" />,
  running: (
    <>
      <circle cx="5" cy="5" r="3.4" strokeWidth="1.4" />
      <circle cx="5" cy="5" fill="currentColor" r="1.3" stroke="none" />
    </>
  ),
  starting: <circle cx="5" cy="5" r="3.4" strokeDasharray="2.2 2" strokeWidth="1.6" />,
  stopped: <rect fill="currentColor" height="6.4" stroke="none" width="6.4" x="1.8" y="1.8" />,
};

export type StatusMarkProps = {
  readonly state: BoardState;
  readonly className?: string;
};

export const StatusMark = ({ className, state }: StatusMarkProps): JSX.Element => (
  <svg
    aria-hidden="true"
    className={cn('shrink-0 text-signal', state === 'busy' && 'rail-busy', className)}
    fill="none"
    height="10"
    stroke="currentColor"
    viewBox="0 0 10 10"
    width="10"
  >
    {GLYPHS[state]}
  </svg>
);
