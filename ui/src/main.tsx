import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { router } from './router.tsx';

/**
 * Nothing is retried: a refused launch has already run whatever it ran, and every
 * read is on a poll that will come round again in seconds anyway.
 */
const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
});

const board = document.querySelector('#board');
if (board === null) {
  throw new Error('the #board mount point is missing from index.html');
}

createRoot(board).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
