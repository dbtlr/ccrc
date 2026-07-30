import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useRef } from 'react';

import {
  createWorkspace,
  fetchRepos,
  fetchSessions,
  launchSession,
  stopSession,
} from './client.ts';
import type { LaunchRequest, Registry, Session, Workspace } from './client.ts';

const SESSIONS_KEY = ['sessions'];
const REPOS_KEY = ['repos'];

/**
 * Slow enough not to hammer a daemon that shells out to tmux on every read, quick
 * enough that a session's state is never stale in the hand.
 */
const POLL_INTERVAL_MS = 3000;
/** A dead daemon is polled at most this rarely, however long it stays down. */
const MAX_POLL_INTERVAL_MS = 30_000;

/**
 * Doubles the wait per consecutive failure so a dead daemon is not hammered every
 * 3s forever, capped at `MAX_POLL_INTERVAL_MS`. Backgrounding the tab already pauses
 * polling on its own — `refetchInterval` skips ticks while the window is unfocused
 * unless `refetchIntervalInBackground` is set, which it is not here.
 */
const backoffInterval = (consecutiveFailures: number): number =>
  Math.min(POLL_INTERVAL_MS * 2 ** consecutiveFailures, MAX_POLL_INTERVAL_MS);

export const useSessions = (): UseQueryResult<Session[]> => {
  // React Query's own failure count resets at the start of every fetch, so it
  // cannot distinguish one failed poll from ten in a row — this can.
  const consecutiveFailures = useRef(0);
  return useQuery({
    queryFn: async () => {
      try {
        const sessions = await fetchSessions();
        consecutiveFailures.current = 0;
        return sessions;
      } catch (error) {
        consecutiveFailures.current += 1;
        throw error;
      }
    },
    queryKey: SESSIONS_KEY,
    refetchInterval: () => backoffInterval(consecutiveFailures.current),
  });
};

/**
 * The launchable list is the config's repos plus whatever is under the workspaces
 * root, scanned per request. It is not polled: creating a workspace here refreshes
 * it, and a directory made outside the console appears on the next page load.
 */
export const useRepos = (): UseQueryResult<Registry> =>
  useQuery({ queryFn: fetchRepos, queryKey: REPOS_KEY, staleTime: Infinity });

export const useCreateWorkspace = (): UseMutationResult<Workspace, Error, string> => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createWorkspace,
    onSuccess: () => client.invalidateQueries({ queryKey: REPOS_KEY }),
  });
};

export const useLaunch = (): UseMutationResult<unknown, Error, LaunchRequest> => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: launchSession,
    onSuccess: () => client.invalidateQueries({ queryKey: SESSIONS_KEY }),
  });
};

export const useStop = (): UseMutationResult<void, Error, string> => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: stopSession,
    onSettled: () => client.invalidateQueries({ queryKey: SESSIONS_KEY }),
  });
};
