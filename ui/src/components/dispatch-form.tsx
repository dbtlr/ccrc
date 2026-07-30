import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent, JSX } from 'react';

import type { LaunchRequest } from '../api/client.ts';
import { useRepos } from '../api/hooks.ts';
import { cn } from '../lib/utils.ts';
import { Heading } from './heading.tsx';
import { Button } from './ui/button.tsx';
import { Field, Select, Textarea } from './ui/field.tsx';

export type DispatchFormProps = {
  readonly launching: boolean;
  readonly onLaunch: (input: LaunchRequest) => void;
};

const EmptyRegistry = (): JSX.Element => (
  <p className="text-body text-muted">
    No repos are registered yet. Add a <code className="font-mono text-data">[[repos]]</code> entry
    to the ccrcd config and restart the daemon.
  </p>
);

/**
 * A launch takes seconds — the daemon waits for the new session to print its attach
 * URL before it answers — so the button owns that whole wait, says so, and cannot
 * be pressed twice.
 */
export const DispatchForm = ({ launching, onLaunch }: DispatchFormProps): JSX.Element => {
  const { data, isPending } = useRepos();
  const repos = data ?? [];
  const [repo, setRepo] = useState('');
  const [prompt, setPrompt] = useState('');

  const firstRepo = repos[0]?.name;
  useEffect(() => {
    if (repo === '' && firstRepo !== undefined) {
      setRepo(firstRepo);
    }
  }, [firstRepo, repo]);

  const chooseRepo = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setRepo(event.target.value),
    [],
  );

  const writePrompt = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value),
    [],
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = prompt.trim();
      onLaunch({ repo, ...(trimmed === '' ? {} : { prompt: trimmed }) });
      setPrompt('');
    },
    [onLaunch, prompt, repo],
  );

  return (
    <section>
      <Heading>dispatch</Heading>
      {!isPending && repos.length === 0 ? (
        <EmptyRegistry />
      ) : (
        <form className="space-y-5" onSubmit={submit}>
          <Field htmlFor="repo" label="Repo">
            <Select disabled={isPending} id="repo" name="repo" onChange={chooseRepo} value={repo}>
              {repos.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field hint="Optional. Slash commands work here." htmlFor="prompt" label="First message">
            <Textarea
              id="prompt"
              name="prompt"
              onChange={writePrompt}
              placeholder="/review the working diff"
              value={prompt}
            />
          </Field>

          <Button
            className={cn(launching && 'sweep')}
            disabled={launching || repo === ''}
            size="wide"
            type="submit"
          >
            {launching ? 'Launching…' : 'Launch session'}
          </Button>
        </form>
      )}
    </section>
  );
};
