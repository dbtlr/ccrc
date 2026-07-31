import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';

import type { Session } from '../api/client.ts';
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
 * what's finished — and reveal into their own run below the toggle, so the boundary
 * never has to be read off the per-strip state words.
 */
export const SessionRack = ({ onStop, stoppingId }: SessionRackProps): JSX.Element => {
  const { data, isPending } = useSessions();
  const sessions = data ?? [];
  const now = Date.now();
  const [showClosed, setShowClosed] = useState(false);
  const toggleClosed = useCallback(() => setShowClosed((prev) => !prev), []);

  const { active, closed } = partitionSessions(sessions);

  // When the last closed record goes away the toggle unmounts; left `true`, the
  // next session to stop would surface itself without being asked for.
  useEffect(() => {
    if (closed.length === 0) {
      setShowClosed(false);
    }
  }, [closed.length]);

  const strips = (list: readonly Session[]): JSX.Element[] =>
    list.map((session) => (
      <SessionStrip
        key={session.id}
        now={now}
        onStop={onStop}
        session={session}
        stopping={stoppingId === session.id}
      />
    ));

  return (
    <section>
      <Heading aside={active.length === 0 ? undefined : `${active.length} active`}>
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
      {active.length === 0 ? null : <ul className="rack space-y-2.5">{strips(active)}</ul>}
      {closed.length === 0 ? null : (
        <Button
          className="mt-2.5 font-mono text-micro text-faint uppercase"
          onClick={toggleClosed}
          variant="ghost"
        >
          {showClosed ? 'hide closed' : `show ${closed.length} closed`}
        </Button>
      )}
      {showClosed && closed.length > 0 ? (
        <ul className="rack mt-2.5 space-y-2.5">{strips(closed)}</ul>
      ) : null}
    </section>
  );
};
