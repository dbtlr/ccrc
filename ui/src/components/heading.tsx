import type { JSX } from 'react';

export type HeadingProps = {
  readonly children: string;
  readonly aside?: string | undefined;
};

/** The board's only section marker: a mono rubric over a hairline. */
export const Heading = ({ aside, children }: HeadingProps): JSX.Element => (
  <div className="mb-4 flex items-baseline justify-between gap-3 border-b border-hairline pb-2.5">
    <h2 className="font-mono text-micro text-muted uppercase">{children}</h2>
    {aside === undefined ? null : (
      <span className="font-mono text-micro text-faint uppercase">{aside}</span>
    )}
  </div>
);
