/**
 * Serializes async critical sections. Both `state.json` and `~/.claude.json` are
 * read-modify-written on nearly every request; two interleaved sequences silently
 * drop one side's change, so each sequence runs as one section instead.
 *
 * Every section waits on the previous section's completion and publishes its own
 * before its first await, so queue order is the call order.
 */
export type Mutex = <T>(section: () => Promise<T>) => Promise<T>;

export const createMutex = (): Mutex => {
  let tail: Promise<void> = Promise.resolve();
  const acquire: Mutex = async (section) => {
    const previous = tail;
    const completion = Promise.withResolvers<void>();
    tail = completion.promise;
    await previous;
    try {
      return await section();
    } finally {
      completion.resolve();
    }
  };
  return acquire;
};
