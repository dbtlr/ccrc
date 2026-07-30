import { Link, Outlet } from '@tanstack/react-router';
import type { JSX } from 'react';

import { useSessions } from '../api/hooks.ts';
import { boardStateOf, isActive } from '../lib/board-state.ts';

const COLUMN = 'mx-auto w-full max-w-[30rem] gutter';

/**
 * How the operator knows the board is telling the truth: the host it describes, how
 * many sessions are live on it, and whether the last poll landed.
 */
const FleetReadout = (): JSX.Element => {
  const { data, isError } = useSessions();
  const sessions = data ?? [];
  const active = sessions.filter((session) => isActive(boardStateOf(session))).length;
  const host = sessions[0]?.host;

  const link = isError ? 'no answer' : 'live';

  return (
    <div className="text-right">
      <p className="font-mono text-data text-muted">{host ?? 'this host'}</p>
      <p className="mt-1 font-mono text-micro text-faint uppercase">
        {active} active
        <span aria-hidden="true" className="px-1.5">
          ·
        </span>
        {link}
      </p>
    </div>
  );
};

export const Shell = (): JSX.Element => (
  <div className="min-h-dvh">
    <header className="sticky top-0 z-10 border-b border-hairline bg-paper/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className={`${COLUMN} flex items-start justify-between gap-4 py-3.5`}>
        <Link className="block" to="/">
          <p className="font-mono text-[1.0625rem] leading-none font-bold tracking-[0.07em]">
            ccrc
          </p>
          <p className="mt-1.5 font-mono text-micro text-faint uppercase">dispatch board</p>
        </Link>
        <FleetReadout />
      </div>
    </header>
    <main className={`${COLUMN} pt-8 pb-[max(3rem,env(safe-area-inset-bottom))]`}>
      <Outlet />
    </main>
  </div>
);

export const NotFound = (): JSX.Element => (
  <section className="space-y-4">
    <p className="font-mono text-micro text-faint uppercase">no such view</p>
    <p className="text-body text-muted">That address is not part of the console.</p>
    <Link className="font-mono text-body underline underline-offset-4" to="/">
      Back to the board
    </Link>
  </section>
);
