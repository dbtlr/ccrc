import type { Session } from '../api/client.ts';

/**
 * What the operator actually needs to know about a session, as one word. The
 * daemon reports two things — its own view of the tmux session, and the session's
 * own busy/idle report — and showing both invites the reader to reconcile them.
 * One state does that reconciliation up front, in the daemon's own vocabulary.
 */
export type BoardState = 'starting' | 'busy' | 'idle' | 'running' | 'stopped' | 'failed';

export const boardStateOf = (session: Session): BoardState => {
  if (session.status === 'starting') {
    return 'starting';
  }
  if (session.status === 'stopped') {
    return 'stopped';
  }
  if (session.status === 'running') {
    return session.activity === 'unknown' ? 'running' : session.activity;
  }
  return 'failed';
};

export const isActive = (state: BoardState): boolean =>
  state === 'starting' || state === 'busy' || state === 'idle' || state === 'running';
