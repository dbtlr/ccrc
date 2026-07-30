# ccrcd

A thin session-launcher daemon for Claude Code. It starts detached, remote-controllable
sessions on the host it runs on, lists them, and stops them — over a small local HTTP API
and a one-screen web console it serves itself.

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
Mutating requests (`POST`, `DELETE`) additionally have to look like they came from a client
the operator meant to use rather than from a web page they happened to visit: an `Origin`
that is neither the daemon's own nor one listed in `allowed_origins` is refused (`403`), and
so is a cross-site `Sec-Fetch-Site`. A mutation that carries a body (`POST`) must also
declare `content-type: application/json` (`415` otherwise) — a content type no cross-origin
form or simple `fetch` can set without a preflight this API never answers. `DELETE` is
bodyless, so the origin checks are all it is held to. Reaching the API from elsewhere means
putting an authenticated transport in front of it.

**Anything that can reach that transport can drive the daemon**, which means it can launch
`bypassPermissions` sessions in any registered repo, read the session list, and stop
sessions. There is no per-user authorization inside ccrcd and no audit trail beyond the
state file. Treat reachability as full control of the host's registered repos.

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

# optional, defaults to none — see "Behind a reverse proxy"
allowed_origins = ["https://ccrc.example"]

[[repos]]
name = "example"
path = "~/code/example"

[[repos]]
name = "notes"
path = "~/notes"
```

Only repos in this registry can be launched; `POST /sessions` takes a registry `name`, never
a path.

### Behind a reverse proxy

The daemon stays loopback-bound, so reaching the console from a phone means fronting it with
a reverse proxy that owns TLS and network exposure:

```caddyfile
ccrc.example {
  reverse_proxy 127.0.0.1:7433
}
```

A browser loading `https://ccrc.example` sends that host as the `Origin` of every mutation,
which is not the daemon's own origin — so without further configuration every launch and
stop would be refused with `403`. `allowed_origins` is how the operator names the proxy:

```toml
allowed_origins = ["https://ccrc.example"]
```

The list is additive and matched by exact string equality. There are no wildcards, no prefix
or suffix matching, and no `null` origin: `http://ccrc.example`, `https://ccrc.example:8443`,
`https://ccrc.example/`, and `https://ccrc.example.somewhere-else` are all different origins
and all still refused. Entries are validated when the config loads — an entry that is not an
absolute `http`/`https` origin, or that carries a path, query, fragment, userinfo, redundant
default port, or non-lowercase host, is a fatal startup error rather than a rule that
silently never matches. The daemon's own origin is always accepted, and an empty or absent
list behaves exactly as if the option did not exist.

Adding an origin does not relax anything else: `Sec-Fetch-Site: cross-site` is still refused
outright, and `POST` still has to declare a JSON content type.

## Run

```sh
bun install
bun run build          # builds the web console into ui/dist
bun run start          # or: bun run dev  (reloads on change)
CCRC_CONFIG=/path/to/config.toml bun run start
```

## Web console

The daemon serves a one-screen operator console from the same port as the API: pick a repo,
optionally give the session a first message, launch it, and watch the board. Each session
shows its state, its uptime, its attach link, and a confirmed stop. It is built for a phone —
one column, touch-sized controls, and no hover-only affordances.

It is a static bundle (`ui/`, built to `ui/dist`) served by the daemon itself, so the console
and the API share an origin and the console is just another HTTP client. The build output is
not committed:

```sh
bun run build          # ui/dist
bun run start
```

Until that build exists the daemon still serves the whole API; the console's URL answers
`503` with the command to run. Deep links work — any path the API does not own returns the
app shell so client-side routing resolves it.

Every response the console serves carries `x-content-type-options: nosniff`, and the shell
also carries `content-security-policy: frame-ancestors 'none'`. Launching a session is one
tap with the repo select defaulting to the first entry, and a same-origin `Origin` check
cannot tell a legitimate tab from an iframe — `frame-ancestors 'none'` is what stops a page
that embeds the console from turning that tap into a one-click launch.

For UI development, run the daemon and Vite side by side; the dev server proxies the API
routes to `127.0.0.1:7433`:

```sh
bun run dev            # the daemon
bun run dev:ui         # the console, on Vite's port
```

## API

All responses are JSON. Errors are `{ "error": "..." }` with a 4xx/5xx status.

```sh
# liveness
curl -s http://127.0.0.1:7433/healthz

# the repo names a launch will accept (paths stay on the host)
curl -s http://127.0.0.1:7433/repos

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
  "tmuxName": "ccrc-example-1",
  "rcName": "ccrc-k7m2p4qd",
  "attachUrl": "https://claude.ai/code/session_01JQ4Z8YB0",
  "pid": 4242,
  "startedAt": 1764000000000,
  "status": "running",
  "activity": "idle"
}
```

The repo's configured path stays on the host — same as `GET /repos` — so it is never part
of a session record either.

`status` is ccrcd's own view of the tmux session (`starting`, `running`, `stopped`,
`failed`). `activity` is the session's own busy/idle report from `claude agents --json`, or
`unknown` when it cannot be correlated. `GET /sessions` returns
`{ "sessions": [...], "hostSessions": [...] }`, where `hostSessions` is the unfiltered host
fleet — including sessions ccrcd did not launch.

Launching pre-accepts the repo's trust dialog and then polls the new tmux pane for the
attach URL. The URL has 60 seconds to appear; a launch that times out, a pane that exits
first, and a kill tmux refuses on `DELETE` all answer `502` and leave the record honest (a
launch that fails after tmux came up kills its tmux session rather than orphaning a
`bypassPermissions` session nothing will revisit). Each individual `tmux` or `claude`
command gets 30 seconds before it is killed and the request answers `504`, so a wedged tmux
server fails a request instead of hanging it. A prompt is capped at 32 KiB and may not
contain NUL bytes.

`status` is only advanced to `stopped` on a definite answer: if tmux cannot say which
sessions are live, records are served as they stand rather than retired wholesale.

## Development

```sh
bun run check     # format, lint, and type checks — daemon and console
bun test          # hermetic unit and HTTP tests (no tmux, no claude CLI, no home writes)
bun run verify    # both
bun run build     # the console bundle
```

`bun run check` covers both halves from the repo root: `src/` and `test/` lint against the
node target, `ui/` against the react target with its own tsconfig driving the type check.
Neither `check` nor `test` needs the console to have been built first.

## License

MIT — see [LICENSE](LICENSE).
