import { useCallback, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import type { Session } from '../api/client.ts';
import { boardStateOf, isActive } from '../lib/board-state.ts';
import { elapsed, startedAt } from '../lib/clock.ts';
import { cn } from '../lib/utils.ts';
import { StatusMark } from './status-mark.tsx';
import { Button } from './ui/button.tsx';

export type SessionStripProps = {
  readonly session: Session;
  readonly now: number;
  readonly stopping: boolean;
  readonly onStop: (id: string) => void;
};

const Ledger = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <p className="font-mono text-data text-muted">{children}</p>
);

const Separator = (): JSX.Element => (
  <span aria-hidden="true" className="px-1.5 text-faint">
    ·
  </span>
);

/**
 * One strip on the rack. Its rail carries the state as colour, the word beside the
 * name carries it as text, and the mark carries it as shape.
 */
export const SessionStrip = ({
  now,
  onStop,
  session,
  stopping,
}: SessionStripProps): JSX.Element => {
  const [confirming, setConfirming] = useState(false);
  const state = boardStateOf(session);
  const live = isActive(state);

  const askToStop = useCallback(() => setConfirming(true), []);
  const keepRunning = useCallback(() => setConfirming(false), []);
  const confirmStop = useCallback(() => {
    setConfirming(false);
    onStop(session.id);
  }, [onStop, session.id]);

  return (
    <li className="strip-enter grid grid-cols-[3px_minmax(0,1fr)]" data-state={state}>
      <span
        aria-hidden="true"
        className={cn('rounded-l-strip bg-signal', state === 'busy' && 'rail-busy')}
      />
      <div className="rounded-r-strip border border-hairline border-l-0 bg-raised px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="truncate font-mono text-strip font-semibold tracking-tight">
            {session.name}
          </h3>
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusMark state={state} />
            <span className="font-mono text-micro text-signal uppercase">{state}</span>
          </span>
        </div>

        <div className="mt-2.5">
          <Ledger>
            {session.repoName}
            {session.pid === null ? null : (
              <>
                <Separator />
                pid {session.pid}
              </>
            )}
          </Ledger>
          <p className="font-mono text-micro text-faint mt-1.5">
            {live ? (
              <>
                up {elapsed(session.startedAt, now)}
                <Separator />
              </>
            ) : null}
            started {startedAt(session.startedAt, now)}
          </p>
        </div>

        {confirming ? (
          <div className="mt-3.5 space-y-2.5">
            <p className="text-data text-muted">
              Stopping kills the tmux session. Anything unsaved in it is lost.
            </p>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={confirmStop} variant="solid">
                Stop {session.name}
              </Button>
              <Button onClick={keepRunning} variant="outline">
                Keep
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3.5 flex gap-2">
            {session.attachUrl === null ? null : (
              <Button asChild className="flex-1" variant="outline">
                <a href={session.attachUrl} rel="noreferrer" target="_blank">
                  Attach
                  <svg
                    aria-hidden="true"
                    fill="none"
                    height="10"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    viewBox="0 0 10 10"
                    width="10"
                  >
                    <path d="M2.2 7.8 7.8 2.2M3.6 2.2h4.2v4.2" />
                  </svg>
                </a>
              </Button>
            )}
            {live ? (
              <Button
                className={session.attachUrl === null ? 'flex-1' : undefined}
                disabled={stopping}
                onClick={askToStop}
                variant="ghost"
              >
                {stopping ? 'Stopping…' : 'Stop'}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </li>
  );
};
