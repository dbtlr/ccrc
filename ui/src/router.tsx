import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';

import { Board } from './routes/board.tsx';
import { NotFound, Shell } from './routes/shell.tsx';

/**
 * A code-defined route tree rather than the file-based plugin: the generated route
 * file would have to exist before the repo could be type-checked, and `bun run
 * check` deliberately does not depend on a build having run.
 *
 * The shell owns the header and the layout every view sits in, so a second view is
 * one `createRoute` call plus a link.
 */
const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: NotFound,
});

const boardRoute = createRoute({
  component: Board,
  getParentRoute: () => rootRoute,
  path: '/',
});

export const router = createRouter({
  defaultPreload: false,
  routeTree: rootRoute.addChildren([boardRoute]),
});

// Declaration merging is what makes `to="/"` typed, and merging needs an interface.
declare module '@tanstack/react-router' {
  // eslint-disable-next-line typescript/consistent-type-definitions
  interface Register {
    router: typeof router;
  }
}
