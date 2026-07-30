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

# optional, defaults to none — see "Workspaces"
workspaces_root = "~/workspaces"

[[repos]]
name = "example"
path = "~/code/example"

[[repos]]
name = "notes"
path = "~/notes"
```

Top-level keys have to come before the first `[[repos]]` table: in TOML a key written after
an array-of-tables header belongs to that table, not to the document.

`POST /sessions` takes a `name`, never a path. Which names it accepts is the registry below.

### Workspaces

The launchable set is the `[[repos]]` above **plus every directory directly under
`workspaces_root`**, scanned on each request. Nothing is written down: a workspace created
through the API, by `git clone`, or with `mkdir` is launchable the moment it exists, and
there is no registry file to drift out of step with the disk.

Say the security consequence out loud: **anything directly under that root can be launched**,
and a launch runs with `bypassPermissions`. The root is a directory handed to the daemon
wholesale, so it should hold work you are content for an unattended session to change — not
`$HOME`. Three things narrow it: the scan is one level deep, it takes only real directories
(a symlink is how something outside the root would otherwise become launchable), and it skips
dotted names. Leave `workspaces_root` out of the config and none of this exists — no scan, no
creation endpoint.

On a name collision the configured repo wins and the shadowed directory is mentioned once in
the log. The root itself need not exist: the first creation makes it.

`POST /workspaces` creates one:

```sh
curl -s -X POST http://127.0.0.1:7433/workspaces \
  -H 'content-type: application/json' \
  -d '{"name":"notes-app"}'
# {"name":"notes-app","path":"/home/you/workspaces/notes-app"}
```

The name has to be a single ordinary path segment — letters, digits, dots, dashes, and
underscores, starting with a letter or digit, at most 64 characters, no `..` — and the
resolved path is checked to land inside the root before anything is created. A name that is
already a directory under the root or a configured repo answers `409`; a daemon with no
`workspaces_root` answers `404`. Creation is a mutation, so it is held to exactly the same
origin and content-type gates as a launch (`403`/`415`).

What it creates is a directory, `git init`, and one empty commit
(`chore: initialize workspace`) so a session has a history to work against from its first
turn. The commit is made with an inline identity (`ccrcd <ccrcd@localhost>`) and signing off,
because a daemon started at login has no git config of its own to fall back on. If `git`
fails, the directory ccrcd just made is removed again rather than left behind as a
half-initialised thing the next scan would offer to launch — unless something else has landed
in it by then, in which case it stays and the log says so.

### Supervision settings

The daemon keeps its own house in order on a timer. Every key below is optional and shown
with its default:

```toml
[supervision]
reconcile_interval_seconds = 30   # how often the loop runs
hang_threshold_minutes = 10       # busy + transcript this stale = hung
restart_cap = 3                   # automatic restarts per lineage per window (0 = never)
restart_cap_window_minutes = 60
stopped_retention_days = 7        # how long stopped/failed records are kept
```

Every duration is a whole number of its own unit inside a range that keeps the loop sane,
and `restart_cap` is a whole number of 0 or more; anything else is a fatal startup error
rather than a setting that silently misbehaves.

| Key                          | Range                                                                                                                                         | Why the ends matter                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `reconcile_interval_seconds` | 5–3600                                                                                                                                        | Under a few seconds ticks pile onto each other; past 2^31-1 ms a timer wraps and fires continuously.                       |
| `hang_threshold_minutes`     | 1–1440                                                                                                                                        | A fraction of a minute would call every busy session hung on the next tick.                                                |
| `restart_cap_window_minutes` | 1–10080, and at least `hang_threshold_minutes`                                                                                                | A window shorter than the threshold could never hold two restarts of one session.                                          |
| `stopped_retention_days`     | 1–365, and at least `restart_cap_window_minutes` expressed in days (`ceil(minutes / 1440)`, so the default 60-minute window needs just 1 day) | Restart history lives on records; retention that expires inside the window would drop the history the cap is counted from. |

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

Every log line is one line, prefixed with an ISO-8601 timestamp; ordinary events go to
stdout and failures to stderr.

## Run as a service

On macOS, a per-user LaunchAgent starts the daemon at login and restarts it if it exits.
The committed plist is a template — the installer fills in the host's paths (`bun` from
`PATH`, the checkout the script lives in, `$HOME`, `$PATH`, and the config location) and
loads the agent:

```sh
packaging/launchd/install.sh     # writes ~/Library/LaunchAgents/dev.ccrc.ccrcd.plist
packaging/launchd/uninstall.sh   # unloads it and removes the plist
```

Logs land in `~/Library/Logs/ccrc/ccrcd.out.log` and `ccrcd.err.log`. **Nothing rotates
them** — launchd appends until something else truncates them, so they belong in whatever
log rotation the host already runs.

The installer refuses to run unless `bun`, `tmux`, and the `claude` CLI are all on the
`PATH` it captures (the agent inherits that `PATH` and nothing else, so a tool missing from
it fails every launch) and the config already exists — a missing config is a fatal startup
error, and `KeepAlive` would turn that into a restart loop. `ThrottleInterval` spaces failed
starts 30 seconds apart so a daemon that cannot start at all cannot spin; the error log is
still where you find out. Set `CCRC_CONFIG` when installing to point the agent at a config
elsewhere. It is a user agent, not a system daemon: sessions run as the operator, and
nothing starts before login.

Uninstalling only removes the agent. Sessions already running under tmux stay up; stop them
through the API.

## Supervision

Reconciliation used to happen only when a client read the API. A loop inside the daemon now
runs every `reconcile_interval_seconds`, plus once at startup, and does three things:

1. **Reconcile.** Records whose tmux session is gone are marked `stopped`. That is also the
   whole of the reboot story: a rebooted host has an empty tmux server, so the startup tick
   retires everything left over. Nothing is ever relaunched on boot — a host coming back up
   must not start `bypassPermissions` sessions on its own. Two things keep this honest: a
   record is exempt from retirement for as long as a launch could still be running (the
   launch timeouts plus a margin), because a liveness snapshot taken during a launch
   legitimately does not list the session yet — including a snapshot taken _before_ the
   record existed, which a slow fleet listing makes ordinary. Only a record stamped
   further ahead than a whole launch window forfeits that, since a clock corrected
   backwards would otherwise make it immortal. And a `starting` record past the window
   whose tmux session _is_ live is promoted to `running`,
   which is what a daemon killed mid-launch leaves behind (its `attachUrl` stays `null` —
   the URL is printed once into the pane and was never captured).
2. **Watch for hangs.** A session is hung only when two signals agree: it reports itself
   `busy`, _and_ the transcript it would be writing to has not moved for
   `hang_threshold_minutes`. Anything indeterminate — an idle session, a session that
   reports no status, one that cannot be correlated to a record, one whose transcript cannot
   be read — never trips the watchdog. A hung session's tmux session is killed, its record
   is marked `stopped` with the reason, and a fresh session is launched in the same repo.
   tmux names are never reused, so the replacement is a new record: it carries
   `restartedFrom`, the retired one carries `restartedAs`. The replacement starts with no
   prompt; the original first message is not stored and is not replayed.
3. **Prune.** `stopped` and `failed` records older than `stopped_retention_days` are dropped,
   measured from when the record ended rather than when it started.

At most `restart_cap` automatic restarts happen per restart lineage within
`restart_cap_window_minutes`. The count comes from `restarts` — the timestamps of the
restarts behind a record, handed to each replacement — rather than from walking
`restartedFrom` links, so pruning, deleting, or hand-editing the dead records cannot reset
it. Past the cap the session is still killed but not replaced, the record says the cap was
reached, and the daemon logs loudly: sessions in that repo keep wedging and want a human.

Ticks never overlap — a tick arriving while one is still running is dropped, not queued — and
every phase is caught and logged on its own, so a tmux that cannot answer neither skips the
prune nor stops the loop nor takes the daemon down. Dropped ticks are logged; a run of more
than three in a row is logged as an error, because that means a tick is wedged and nothing
is being reconciled, watched, or pruned at all.

## Web console

The daemon serves a one-screen operator console from the same port as the API: pick a repo —
or name a new workspace, which is created and launched into in one gesture — optionally give
the session a first message, launch it, and watch the board. Each session
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

`CCRC_UI_DIR` overrides where the built console is read from, for a build placed somewhere
other than `ui/dist`. It is trusted as given: whatever directory it names is served, so
pointing it at anything other than a `ui/dist`-shaped build turns the daemon into a
loopback-reachable read-only file server over that directory instead.

## API

All responses are JSON. Errors are `{ "error": "..." }` with a 4xx/5xx status.

```sh
# health: tmux reachable, claude CLI reachable, state file writable
curl -s http://127.0.0.1:7433/healthz

# the names a launch will accept: configured repos plus what is under the
# workspaces root right now (paths stay on the host)
curl -s http://127.0.0.1:7433/repos

# create a workspace under the workspaces root and git-initialise it
curl -s -X POST http://127.0.0.1:7433/workspaces \
  -H 'content-type: application/json' \
  -d '{"name":"notes-app"}'

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

`GET /healthz` probes the three things the daemon cannot work without, each bounded by a
short two-second timeout so health answers while the trouble is happening:

```json
{ "ok": true, "checks": { "tmux": "ok", "claude": "ok", "state": "ok" } }
```

A failed check answers `503` with that check marked `failed`. _Why_ it failed goes to the
log, not the response: a probe failure quotes host paths and command output, and `/healthz`
is the one route with no origin check in front of it.

Each run spawns processes, so concurrent callers share one run and the answer is reused for
five seconds. That bounds the spawn rate however hard the route is hit — and means a
dependency that has just recovered reads as unwell for up to that long.

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
  "hostSessionId": "0c2f1d6e-...",
  "startedAt": 1764000000000,
  "endedAt": null,
  "status": "running",
  "stopReason": null,
  "restartedFrom": null,
  "restartedAs": null,
  "restarts": [],
  "activity": "idle"
}
```

`endedAt` is when the record went terminal, and `stopReason` is why — set when ccrcd decided
to end it (its tmux session was gone, a launch failed, the watchdog found it hung) and left
`null` for an operator's own `DELETE`. `restartedFrom` and `restartedAs` cross-link a hung
session to the one that replaced it, in both directions and even when the replacement's own
launch failed. `pid` and `hostSessionId` are how a record claims its entry in the host
fleet, which is what stops the next session in a repo from adopting a killed session's
entry — the CLI lists a killed session for a while, and an adopted entry would hand a
healthy session a stranger's activity and a stranger's stale transcript. Every kill claims
it — an operator's `DELETE`, the watchdog's restart, and a session that died on its own
and is found by reconciliation. A `DELETE` still kills the tmux session and retires the
record when the `claude` CLI cannot be reached at all; it just has no claim to record. The claim expires with the session: a record that has
ended only claims entries that started before it did, so a pid the OS later reuses is free.
`restarts` is the automatic-restart history the cap is counted from.

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

Records are reconciled on every read and by the supervision loop, so a record can change
between two reads without anyone calling `DELETE` — see [Supervision](#supervision).

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
