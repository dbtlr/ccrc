import { useCallback, useState } from 'react';
import type { JSX } from 'react';

import type { LaunchRequest } from '../api/client.ts';
import { useLaunch, useRepos, useSessions, useStop } from '../api/hooks.ts';
import { DispatchForm } from '../components/dispatch-form.tsx';
import { Notice } from '../components/notice.tsx';
import { SessionRack } from '../components/session-rack.tsx';

/**
 * The console. Dispatch above, the rack below, and one place for whatever the daemon
 * last refused to do — the mutations live here because both panels report into the
 * same notice.
 */
export const Board = (): JSX.Element => {
  const sessions = useSessions();
  const repos = useRepos();
  const launch = useLaunch();
  const stop = useStop();
  const [dismissed, setDismissed] = useState('');

  const startLaunch = useCallback(
    (input: LaunchRequest) => {
      setDismissed('');
      launch.mutate(input);
    },
    [launch],
  );

  const startStop = useCallback(
    (id: string) => {
      setDismissed('');
      stop.mutate(id);
    },
    [stop],
  );

  const failure =
    launch.error?.message ?? stop.error?.message ?? repos.error?.message ?? sessions.error?.message;
  const dismiss = useCallback(() => setDismissed(failure ?? ''), [failure]);
  const showing = failure === undefined || failure === dismissed ? undefined : failure;

  return (
    <div className="space-y-10">
      {showing === undefined ? null : (
        <Notice label="error" message={showing} onDismiss={dismiss} />
      )}
      <DispatchForm launching={launch.isPending} onLaunch={startLaunch} />
      <SessionRack onStop={startStop} stoppingId={stop.isPending ? stop.variables : undefined} />
    </div>
  );
};
