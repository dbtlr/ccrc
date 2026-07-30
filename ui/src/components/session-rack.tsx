import type { JSX } from 'react';

import { useSessions } from '../api/hooks.ts';
import { Heading } from './heading.tsx';
import { SessionStrip } from './session-strip.tsx';

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
 * nothing.
 */
export const SessionRack = ({ onStop, stoppingId }: SessionRackProps): JSX.Element => {
  const { data, isPending } = useSessions();
  const sessions = data ?? [];
  const now = Date.now();

  return (
    <section>
      <Heading aside={sessions.length === 0 ? undefined : `${sessions.length} on record`}>
        sessions
      </Heading>
      {isPending ? <Placeholder>Reading the board…</Placeholder> : null}
      {!isPending && sessions.length === 0 ? (
        <Placeholder>
          Nothing has been launched on this host yet. Pick a repo above and start a session.
        </Placeholder>
      ) : null}
      {sessions.length === 0 ? null : (
        <ul className="rack space-y-2.5">
          {sessions.map((session) => (
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
    </section>
  );
};
