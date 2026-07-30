import { useCallback, useState } from 'react';
import type { JSX } from 'react';

import type { LaunchRequest } from '../api/client.ts';
import { useCreateWorkspace, useLaunch, useRepos, useSessions, useStop } from '../api/hooks.ts';
import { DispatchForm } from '../components/dispatch-form.tsx';
import type { CreateAndLaunchRequest } from '../components/dispatch-form.tsx';
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
  const create = useCreateWorkspace();
  const [dismissed, setDismissed] = useState('');

  // A mutation keeps its error until its own next `mutate()` or a `reset()` —
  // clearing the *other* one here is what stops a dismissed launch failure from
  // outliving it and masking a fresh stop failure (or the reverse).
  const startLaunch = useCallback(
    (input: LaunchRequest) => {
      setDismissed('');
      stop.reset();
      create.reset();
      launch.mutate(input);
    },
    [create, launch, stop],
  );

  /**
   * Two requests, one gesture: the launch is chained off the creation's own success
   * so a workspace that could not be made never becomes a launch against a name that
   * does not exist. A failed creation leaves its message in the notice below.
   */
  const startCreateAndLaunch = useCallback(
    async ({ name, prompt }: CreateAndLaunchRequest): Promise<void> => {
      setDismissed('');
      stop.reset();
      launch.reset();
      // Resolves when the workspace exists (the form resets on that), rejects when it
      // could not be made (the form keeps the name for correction). The launch is
      // still chained off the creation's success and reports into the same notice.
      const created = await create.mutateAsync(name);
      launch.mutate({ repo: created.name, ...(prompt === undefined ? {} : { prompt }) });
    },
    [create, launch, stop],
  );

  const startStop = useCallback(
    (id: string) => {
      setDismissed('');
      launch.reset();
      create.reset();
      stop.mutate(id);
    },
    [create, launch, stop],
  );

  /**
   * A root the daemon cannot read is not a failed request — the configured repos are
   * still listed and still launch — so it reports as the same notice everything else
   * does, behind whatever went wrong more recently.
   */
  const workspacesUnavailable =
    repos.data?.workspacesUnavailable === true
      ? 'ccrcd could not read the workspaces root, so only configured repos are listed.'
      : undefined;

  const failure =
    create.error?.message ??
    launch.error?.message ??
    stop.error?.message ??
    repos.error?.message ??
    sessions.error?.message ??
    workspacesUnavailable;
  const dismiss = useCallback(() => setDismissed(failure ?? ''), [failure]);
  const showing = failure === undefined || failure === dismissed ? undefined : failure;

  return (
    <div className="space-y-10">
      {showing === undefined ? null : (
        <Notice label="error" message={showing} onDismiss={dismiss} />
      )}
      <DispatchForm
        launching={launch.isPending || create.isPending}
        onCreateAndLaunch={startCreateAndLaunch}
        onLaunch={startLaunch}
      />
      <SessionRack onStop={startStop} stoppingId={stop.isPending ? stop.variables : undefined} />
    </div>
  );
};
