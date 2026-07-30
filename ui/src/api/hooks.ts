import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import { fetchRepos, fetchSessions, launchSession, stopSession } from './client.ts';
import type { LaunchRequest, Repo, Session } from './client.ts';

const SESSIONS_KEY = ['sessions'];
const REPOS_KEY = ['repos'];

/**
 * Slow enough not to hammer a daemon that shells out to tmux on every read, quick
 * enough that a session's state is never stale in the hand.
 */
const POLL_INTERVAL_MS = 3000;

export const useSessions = (): UseQueryResult<Session[]> =>
  useQuery({
    queryFn: fetchSessions,
    queryKey: SESSIONS_KEY,
    refetchInterval: POLL_INTERVAL_MS,
  });

/** The registry only changes when the daemon is restarted with a new config. */
export const useRepos = (): UseQueryResult<Repo[]> =>
  useQuery({ queryFn: fetchRepos, queryKey: REPOS_KEY, staleTime: Infinity });

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
