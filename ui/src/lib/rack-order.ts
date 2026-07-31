import type { Session } from '../api/client.ts';
import { boardStateOf, isActive } from './board-state.ts';
import type { BoardState } from './board-state.ts';

/**
 * Most-active-first ranking for the open half of the rack. `running` sits
 * ahead of `starting` because its activity is merely unreported, not absent —
 * it may well be busy.
 */
const ACTIVITY_RANK: Record<BoardState, number> = {
  busy: 0,
  failed: 4,
  idle: 3,
  running: 1,
  starting: 2,
  stopped: 4,
};

const byActivity = (a: Session, b: Session): number => {
  const rank = ACTIVITY_RANK[boardStateOf(a)] - ACTIVITY_RANK[boardStateOf(b)];
  return rank !== 0 ? rank : b.startedAt - a.startedAt;
};

const closedAt = (session: Session): number => session.endedAt ?? session.startedAt;

const byClosedAt = (a: Session, b: Session): number => {
  const diff = closedAt(b) - closedAt(a);
  return diff !== 0 ? diff : b.startedAt - a.startedAt;
};

export type SessionPartition = {
  readonly active: Session[];
  readonly closed: Session[];
};

/**
 * Splits the rack into what the operator watches and what it has already
 * finished with, each sorted for the reading order that section wants.
 */
export const partitionSessions = (sessions: readonly Session[]): SessionPartition => {
  const active: Session[] = [];
  const closed: Session[] = [];
  for (const session of sessions) {
    (isActive(boardStateOf(session)) ? active : closed).push(session);
  }
  active.sort(byActivity);
  closed.sort(byClosedAt);
  return { active, closed };
};
