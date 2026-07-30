# ccrcd

A thin session-launcher daemon for Claude Code. It starts detached, remote-controllable
sessions on the host it runs on, lists them, and stops them — over a small local HTTP API.

ccrcd never carries a conversation. It hands out an attach URL and gets out of the way:
steering the session is Anthropic Remote Control's job (`https://claude.ai/code/session_…`).

Every call into the `claude` CLI, tmux, and `~/.claude.json` is confined to a single
adapter module (`src/adapter/claude.ts`), so CLI drift is a one-file fix.

## Before you run it

Two facts decide where this daemon may listen:

- **Sessions run with `--permission-mode bypassPermissions`.** A launched session executes
  whatever it decides to execute inside the target repo, unattended and unprompted.
- **The API has no authentication.** Anyone who can reach the port can launch a session.

Together those make `POST /sessions` arbitrary code execution, so the bind is restricted to
loopback: a `bind` outside `127.0.0.0/8`, `::1`, or `localhost` is a fatal startup error.
Mutating requests (`POST`, `DELETE`) additionally have to look like they came from a local
client rather than from a web page the operator happened to visit — `content-type:
application/json` is required (`415` otherwise), and a cross-origin `Origin` or a cross-site
`Sec-Fetch-Site` is refused (`403`). Reaching the API from elsewhere means putting an
authenticated transport in front of it.

## Requirements

- [Bun](https://bun.sh)
- `tmux` on `PATH`
- the `claude` CLI on `PATH`

## Config

TOML at `~/.config/ccrc/config.toml`, or wherever `CCRC_CONFIG` points. Session records are
persisted to `state.json` in the same directory. A missing config is a fatal startup error.

```toml
bind = "127.0.0.1"   # optional, defaults to 127.0.0.1; must be loopback
port = 7433          # optional, defaults to 7433

[[repos]]
name = "example"
path = "~/code/example"

[[repos]]
name = "notes"
path = "~/notes"
```

Only repos in this registry can be launched; `POST /sessions` takes a registry `name`, never
a path.

## Run

```sh
bun install
bun run start          # or: bun run dev  (reloads on change)
CCRC_CONFIG=/path/to/config.toml bun run start
```

## API

All responses are JSON. Errors are `{ "error": "..." }` with a 4xx/5xx status.

```sh
# liveness
curl -s http://127.0.0.1:7433/healthz

# launch a session (optional first prompt, slash commands included)
curl -s -X POST http://127.0.0.1:7433/sessions \
  -H 'content-type: application/json' \
  -d '{"repo":"example","prompt":"/review the working diff"}'

# every ccrcd-launched session, reconciled against tmux, plus the raw host fleet
curl -s http://127.0.0.1:7433/sessions

# one session
curl -s http://127.0.0.1:7433/sessions/<id>

# stop a session (kills its tmux session)
curl -s -X DELETE http://127.0.0.1:7433/sessions/<id>
```

A session record looks like:

```json
{
  "id": "k7m2p4qd",
  "name": "example-1",
  "host": "workstation",
  "repoName": "example",
  "repoPath": "/Users/me/code/example",
  "tmuxName": "ccrc-example-1",
  "rcName": "ccrc-k7m2p4qd",
  "attachUrl": "https://claude.ai/code/session_01JQ4Z8YB0",
  "pid": 4242,
  "startedAt": 1764000000000,
  "status": "running",
  "activity": "idle"
}
```

`status` is ccrcd's own view of the tmux session (`starting`, `running`, `stopped`,
`failed`). `activity` is the session's own busy/idle report from `claude agents --json`, or
`unknown` when it cannot be correlated. `GET /sessions` returns
`{ "sessions": [...], "hostSessions": [...] }`, where `hostSessions` is the unfiltered host
fleet — including sessions ccrcd did not launch.

Launching pre-accepts the repo's trust dialog and then polls the new tmux pane for the
attach URL. The URL has 60 seconds to appear; a launch that times out, a pane that exits
first, and a kill tmux refuses on `DELETE` all answer `502` and leave the record honest (a
timed-out launch kills its tmux session rather than orphaning it). A prompt is capped at
32 KiB and may not contain NUL bytes.

## Development

```sh
bun run check     # format, lint, and type checks
bun test          # hermetic unit and HTTP tests (no tmux, no claude CLI, no home writes)
bun run verify    # both
```

## License

MIT — see [LICENSE](LICENSE).
