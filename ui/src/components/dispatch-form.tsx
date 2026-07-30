import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent, JSX } from 'react';

import type { LaunchRequest } from '../api/client.ts';
import { useRepos } from '../api/hooks.ts';
import { cn } from '../lib/utils.ts';
import { Heading } from './heading.tsx';
import { Button } from './ui/button.tsx';
import { Field, Input, Select, Textarea } from './ui/field.tsx';

export type CreateAndLaunchRequest = {
  readonly name: string;
  readonly prompt?: string | undefined;
};

export type DispatchFormProps = {
  readonly launching: boolean;
  readonly onLaunch: (input: LaunchRequest) => void;
  readonly onCreateAndLaunch: (input: CreateAndLaunchRequest) => void;
};

/**
 * A launch takes seconds — the daemon waits for the new session to print its attach
 * URL before it answers — so the button owns that whole wait, says so, and cannot
 * be pressed twice.
 *
 * Creating a workspace is folded into the same button rather than given a screen of
 * its own: naming a new workspace and starting a session in it is one intention, so
 * it stays one gesture, even though it costs the daemon two requests.
 */
export const DispatchForm = ({
  launching,
  onCreateAndLaunch,
  onLaunch,
}: DispatchFormProps): JSX.Element => {
  const { data, isPending } = useRepos();
  const repos = data?.repos ?? [];
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);

  const firstRepo = repos[0]?.name;
  useEffect(() => {
    if (repo === '' && firstRepo !== undefined) {
      setRepo(firstRepo);
    }
  }, [firstRepo, repo]);

  // Nothing to pick from yet: the only way forward is to make something.
  const empty = !isPending && repos.length === 0;
  const naming = creating || empty;

  const chooseRepo = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setRepo(event.target.value),
    [],
  );

  const writeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    [],
  );

  const writePrompt = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value),
    [],
  );

  const toggleNaming = useCallback(() => {
    setCreating((wasCreating) => !wasCreating);
    setName('');
  }, []);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = prompt.trim();
      const message = trimmed === '' ? {} : { prompt: trimmed };
      if (naming) {
        onCreateAndLaunch({ name: name.trim(), ...message });
      } else {
        onLaunch({ repo, ...message });
      }
      setPrompt('');
    },
    [name, naming, onCreateAndLaunch, onLaunch, prompt, repo],
  );

  const nothingChosen = naming ? name.trim() === '' : repo === '';
  const idleLabel = naming ? 'Create & launch' : 'Launch session';

  return (
    <section>
      <Heading>dispatch</Heading>
      <form className="space-y-5" onSubmit={submit}>
        {naming ? (
          <Field
            hint="Created under the workspaces root and given a git repo with one empty commit."
            htmlFor="workspace"
            label="New workspace"
          >
            <Input
              autoCapitalize="off"
              autoCorrect="off"
              id="workspace"
              name="workspace"
              onChange={writeName}
              placeholder="notes-app"
              spellCheck={false}
              value={name}
            />
          </Field>
        ) : (
          <Field htmlFor="repo" label="Repo">
            <Select disabled={isPending} id="repo" name="repo" onChange={chooseRepo} value={repo}>
              {repos.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {empty ? null : (
          <button
            className="font-mono text-micro text-muted uppercase underline underline-offset-4"
            onClick={toggleNaming}
            type="button"
          >
            {creating ? 'Pick an existing repo' : 'New workspace'}
          </button>
        )}

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
          disabled={launching || nothingChosen}
          size="wide"
          type="submit"
        >
          {launching ? 'Launching…' : idleLabel}
        </Button>
      </form>
    </section>
  );
};
