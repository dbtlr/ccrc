import { useCallback, useState } from 'react';
import type { JSX } from 'react';

import { useSessions } from '../api/hooks.ts';
import { partitionSessions } from '../lib/rack-order.ts';
import { Heading } from './heading.tsx';
import { SessionStrip } from './session-strip.tsx';
import { Button } from './ui/button.tsx';

export type SessionRackProps = {
  readonly stoppingId: string | undefined;
  readonly onStop: (id: string) => void;
};

const Placeholder = ({ children }: { readonly children: string }): JSX.Element => (
  <p className="text-body text-muted">{children}</p>
);

/**
 * The rack. It reads the polled session list itself rather than being handed one,
 * so the poll has a single owner and the header's readout of the same query costs
 * nothing. Closed sessions start hidden — the operator watches what's running, not
 * what's finished — but a toggle can bring them back.
 */
export const SessionRack = ({ onStop, stoppingId }: SessionRackProps): JSX.Element => {
  const { data, isPending } = useSessions();
  const sessions = data ?? [];
  const now = Date.now();
  const [showClosed, setShowClosed] = useState(false);
  const toggleClosed = useCallback(() => setShowClosed((prev) => !prev), []);

  const { active, closed } = partitionSessions(sessions);
  const shown = showClosed ? [...active, ...closed] : active;

  return (
    <section>
      <Heading aside={sessions.length === 0 ? undefined : `${active.length} active`}>
        sessions
      </Heading>
      {isPending ? <Placeholder>Reading the board…</Placeholder> : null}
      {!isPending && sessions.length === 0 ? (
        <Placeholder>
          Nothing has been launched on this host yet. Pick a repo above and start a session.
        </Placeholder>
      ) : null}
      {!isPending && sessions.length > 0 && active.length === 0 ? (
        <Placeholder>Nothing running right now.</Placeholder>
      ) : null}
      {shown.length === 0 ? null : (
        <ul className="rack space-y-2.5">
          {shown.map((session) => (
            <SessionStrip
              key={session.id}
              now={now}
              onStop={onStop}
              session={session}
              stopping={stoppingId === session.id}
            />
          ))}
        </ul>
      )}
      {closed.length === 0 ? null : (
        <Button
          className="mt-2.5 font-mono text-micro text-faint uppercase"
          onClick={toggleClosed}
          variant="ghost"
        >
          {showClosed ? 'hide closed' : `show ${closed.length} closed`}
        </Button>
      )}
    </section>
  );
};
