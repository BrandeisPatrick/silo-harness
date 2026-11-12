# A sandbox for the shell: design

Status: design only, 2026-11-11. Nothing is built or decided. The sandbox changes what runs without asking, so no
product code is written before the owner says yes to the questions in section 10.

**The idea.** In Auto mode every `bash` command off the read-only list costs a safety check (a model call). Instead,
run it in a macOS Seatbelt sandbox (`/usr/bin/sandbox-exec`) that writes only in the project and temp folders, reads
all but secrets, and reaches no network but this Mac's own ports. A command that stays inside needs no check; one that
hits a wall goes to the check as today and, allowed, runs again outside. Codex CLI and DeepSeek Harness work this way
(`tool-call-comparison.md` B3.2, branch `efficiency-research`). Of the 25 checks left in the logged run after
`fewer-checks`, 19 would run in the sandbox (section 8).

## 1. The profile

Base: allow by default, then deny (DeepSeek's shape; its sandbox confines only writes, leaving reads and the network
open). Codex starts from deny-all and adds back what tools need, network and loopback closed by default: tighter, but
a long tuned list of system services, where a missing one breaks tools in odd ways. The denies below close the ways
out found so far; three are untested (section 9).

| | Allowed | Denied |
| --- | --- | --- |
| Write | the project folder; `/private/tmp`; the user's own `/private/var/folders/<x>/<y>/` (`$TMPDIR` and the cache folder next to it); `/dev/null`, `/dev/tty`, `/dev/fd/*`; extra folders the user lists | everything else; inside the project, the protected paths of section 2 |
| Read | everything | the guard's secret paths (`SECRET_PATH_RE`, the app's data folder, the `settings.json` files), at any depth; `.env.example` and the like stay readable |
| Network | TCP bind, accept and connect on `localhost`; Unix sockets inside the project | everything else, DNS included (tested: denying `network*` also stops name lookups) |
| Other processes | signals inside the same sandbox | Apple Events (`appleevent-send`), opening apps and files (`lsopen`, LaunchServices), writing preferences (`user-preference-write`, the cfprefs daemon), the keychain (`com.apple.SecurityServer`), launchd jobs (`job-creation`), signals to anything else |

The temp rule matches the guard, which already treats `/tmp` and `/var/folders` as inside (`guard.ts` `TMP_RE`).
Paths are real paths (`/tmp` is `/private/tmp`); folders go in as `-D` parameters, and patterns that need the project
folder embed it escaped, because a parameter cannot sit inside a regex. Seatbelt regexes have no look-ahead, so the
`.env.example` exception is a later allow rule; the last matching rule wins (tested).

The draft profile, shortened (`P` is the escaped project path; the prototype ran it with the session temp folder as
`TMP`, and `job-creation` was only checked to parse):

```scheme
(version 1) (allow default)
(deny file-write*)
(allow file-write* (subpath (param "PROJECT")) (subpath (param "TMP")) (literal "/dev/null") (regex #"^/dev/fd/") …)
(deny file-write* (regex #"^P/(.*/)?\.git(/|$)")
  (regex #"^P/(.*/)?(\.vscode|\.idea|\.husky|\.envrc|\.mcp\.json|\.gitmodules|\.github/workflows|\.silo-harness|\.open-harness|\.claude)(/|$)"))
(allow file-write* (regex #"^P/(.*/)?\.claude/(skills|commands|agents|worktrees)(/|$)") (regex #"^P/(.*/)?\.silo-harness/skills(/|$)"))
(deny file-read* (regex #"/(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.config/gh)(/|$)") (regex #"/\.env(\.[^/]+)?$") …)
(allow file-read* (regex #"/\.env\.(example|sample|template|dist)$"))
(deny network*)
(allow network-bind network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))
(allow network* (local unix-socket (subpath (param "PROJECT"))) (remote unix-socket (subpath (param "PROJECT"))))
(deny appleevent-send) (deny lsopen) (deny user-preference-write) (deny job-creation)
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name-prefix "com.apple.lsd.")
  (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.SecurityServer"))
(deny signal) (allow signal (target same-sandbox))
```

**The environment.** `shell.ts` passes the app's whole environment on, and `settings.json`'s `env` block puts keys
there; a sandboxed script could print them, where today it would meet the check. So a sandboxed run drops variables
whose names end in `KEY`, `TOKEN`, `SECRET` or `PASSWORD` (the rule a project's settings file follows); with the
network closed nothing inside could use them. A rerun outside gets the full environment. What the login profile
exports comes back with `zsh -l`, but `cat ~/.zshrc` runs unasked today too, so that is no new opening.

## 2. Protected paths inside the project

- **Every `.git`, at any depth, is read-only and cannot be created, moved or replaced.** Writable `objects` and
  `refs` would let a script delete unpushed history without a check, and the files that run code later are more
  than `config` and `hooks` (`config.worktree`, `commondir`, the `.git` pointer file of a worktree). Codex makes
  `.git` read-only for the same reason (`codex-rs/protocol/src/permissions.rs`, `default_read_only_subpaths_for_writable_root`).
  Tested: `git status` and `git log` work; `git add` fails on `.git/index.lock`. So git commands that write go
  straight to the check (section 4), as today. In a linked worktree the real git folder is in the main clone,
  outside the project, so it is read-only either way.
- The guard's other protected names (`PROTECTED_IN_PROJECT`, with the skills, commands, agents and worktrees folders
  left open) are denied at any depth, not only at the project root: a nested `.envrc` or `.claude/settings.json`
  runs code when someone opens that folder.
- Silo's rule files and data folder are outside the project (so unwritable) and read-denied. **The nested case.** Today `guardWrite` (the file tools) and `protectedWrite` check only the root `.git` and the
  root's protected names, and the command guard reads only the command's text. The sandbox closes it for every
  program, interpreters included. Tested: writing `sub/.git/config` and `mv x sub2/.git` are both refused. The same
  change should make `protectedWrite` match at any depth, so `write_file` agrees with the shell.

## 3. Friction

| Case | What happens | Source |
| --- | --- | --- |
| A test that starts a server and calls it | works: bind and connect on `localhost` are allowed | tested |
| A job started with `&` | keeps running after the call returns, still sandboxed | tested (`sleep`) |
| Stopping it from a later command | `kill` fails: each call is its own sandbox, and `same-sandbox` does not cover another call. Goes to the check, or Silo's own Stop | tested |
| Reaching a service started outside (a database on 5432, a local gateway) | works over TCP: the risk side of loopback (question 2). Unix sockets outside the project are refused | tested |
| `npm install`, `pip install`, `cargo add`, `brew` | need the network and caches in the home folder: listed, straight to the check | read |
| `npm config get` with `~/.npmrc` unreadable; `npm run` with `~/.npm` unwritable | both work, no error printed | tested |
| `git` reading `~/.gitconfig` | works; git writes go to the check (section 2) | tested |
| Tools writing `~/Library/Caches`, `~/.cache`, Xcode's DerivedData | refused; the check then reruns them outside. The user can add folders | inferred |
| A library that swallows a refused read (dotenv and `.env`) | no error text, odd behaviour: detection misses it (section 4) | inferred |
| Child processes | inherit the sandbox: a Python script writing outside is refused | tested |
| The login profile (`zsh -l`) | The owner's ran clean with writes confined; one that writes (pyenv rehash, nvm) would print errors each time | tested / inferred |
| Profile syntax error | `sandbox-exec` exits 65 with `sandbox-exec: …` and runs nothing | tested |

## 4. When the sandbox blocks something

**Detecting it.** The unified log is no help: no entry appeared for a denied write under `sandbox-exec`, even with
modifiers, and `log show` took 1.5 s (tested). So, as Codex and DeepSeek do (`codex-rs/sandboxing/src/denial.rs`;
DeepSeek `packages/sandbox/sandbox-local/src/index.ts`, `DENIAL_SIGNATURES`), a block is a non-zero exit whose
output holds `Operation not permitted`, `EPERM`, `[Errno 1]`, or a name-lookup failure (`nodename nor servname`,
`ENOTFOUND`, `Could not resolve host`); exits 2, 126 and 127 are not. Lines the login profile prints on its own
(one sandboxed `zsh -lc true` per session) are ignored. Exit 65 with `sandbox-exec:` is a broken profile: nothing ran,
the sandbox turns off for the session, and commands go to the check.

A false alarm (a real permission error) costs one check and a rerun: today's price, never looser. A miss (an error
swallowed) leaves the model with odd output, so the tool description names the sandbox's limits, and `bash` takes
`outside: true`, which sends the call to the check and runs it outside (as DeepSeek's `sandbox_permissions` and
Codex's `require_escalated` do).

**What follows.** A block goes to the check with the command, the line that showed the block and the end of the
output. Allowed, the command runs again outside the sandbox with the full environment, and the row shows both runs.
Blocked, the agent reads "Blocked by Auto mode: …" and the sandboxed output. Paused Auto mode shows the card. The
check is told the command already ran once inside, because a rerun can repeat what the first run did in the project
(an append, a migration); most commands (builds, tests, installs) are safe to repeat.

**Known commands skip the first attempt.** A command that will surely hit the wall goes straight to the check, as
today, instead of failing first: installs (`npm`/`pnpm`/`yarn`/`bun` install, add, ci, update; `pip`, `uv`, `gem`,
`cargo install`, `go get`, `brew`), network clients (`curl` and `wget` to a host other than localhost, `gh`, `git`
clone, fetch, pull, push, ls-remote, submodule), git commands that write, `kill`, `open`, `osascript`. A wrong entry
only costs today's check. Recommended: yes.

## 5. Where it sits in the order

1. Unchanged, first: a write to a rule file (firm card), deny rules, ask rules, PreToolUse hooks.
2. **Plan mode**: only read-only commands run, as today; they now run in the sandbox with no project writes either.
   This only tightens: the read-only list is text reading, and 0.17.1 fixed "reads" that ran code or wrote files.
3. **Ask, Accept edits, Bypass**: unchanged. The user approves (or Bypass runs) a command, and it runs outside.
4. **Auto mode**, per command: `sudo` and deleting a critical folder ask, as today; a guard reason (reads secrets,
   pushes, cloud, writes outside, a protected path) goes the way it goes today (rules, then the check); a command a
   user's allow rule covers runs outside, as today; a command on the known list goes to the check; **everything else
   runs in the sandbox with no check, read-only commands included**. A block goes to the check (section 4).
5. Paused Auto mode: sandboxed commands still run; a block shows the card. Check unavailable: such commands run
   today with neither, so the sandbox only tightens. `terminal_run` (the interactive terminal) is not sandboxed.

**What stays.** The read-only list still decides what Plan mode runs at all, and what runs when the sandbox is off or
missing. The check still decides everything that leaves the sandbox, MCP calls, browser cards, and protected writes
by the file tools. The guard keeps the first say, and its privacy reasons ("scans the home folder"): reads stay open,
so a walk of `~/Desktop` can still raise macOS's prompt in the app's name (not tested).

**What runs unasked that does not today** (section 10 asks for each):

- Any command whose effects stay in the project and temp folders, deleting or overwriting project files included
  (`write_file` can already overwrite any project file with no check; `.git` stays protected).
- Printing a secret file the list does not name (`~/.config/gcloud`, `~/.kube/config`, `~/.git-credentials`, shell
  history); talking to a service on this Mac's own ports; writing anywhere in `/private/tmp`, which tools share.

What gets tighter: interpreters can no longer write outside or read a listed secret unseen (the guard reads only the
command's text), nested `.git` folders are protected, and Plan mode's reads are enforced.

## 6. What the user sees and sets

- The bash row gets a small "sandbox" mark; its details say "Ran in the sandbox", or "Sandbox blocked: network ·
  checked · ran outside". `/report` and the timing log count sandboxed runs, blocks and reruns.
- Settings → Permissions → Auto mode: "Run commands in a sandbox" (on/off), "Local ports" (on/off), "Folders commands
  may also write" (a list). In the user's own `settings.json` only: `sandbox.enabled`, `sandbox.loopback`,
  `sandbox.allowWrite`. A project's `.silo-harness/settings.json` may not set them (skipped with a problem line, as
  `autoMode` is), and the agent cannot write the user's file (a rule file: firm card in every mode).
- **Hosts** cannot be allowed one by one: Seatbelt matches IP and port, and only `localhost` or `*` as a host. A host
  list needs a local proxy that the sandbox may reach (Codex does this, `seatbelt.rs` proxy ports). Later, not now.

## 7. macOS facts

- `/usr/bin/sandbox-exec` is on this Mac (macOS 27.2.1, binary dated 2026-11-06). Its manual page says
  "DEPRECATED" and points to App Sandbox; the page is dated 2017 and the tool still ships. Codex CLI and DeepSeek
  Harness call it (read in source). The engine underneath (Seatbelt) also confines Apple's and Chrome's own processes.
- No prompt and no entitlement: it ran from a plain shell, and the profile confines only the child. Silo spawns
  `/usr/bin/sandbox-exec` by absolute path, as it spawns `/bin/zsh` today (Codex uses the absolute path so a planted
  copy on `PATH` cannot stand in), with `-p <profile> -D… -- /bin/zsh -lc "setopt nonomatch; <command>"`; cwd,
  pipes, timeout and the process group stay as in `shell.ts`. Silo's mac build sets no App Sandbox entitlement
  (`package.json` `build.mac`) and must keep it so: a process already in a sandbox is not expected to apply another
  (not tested). A probe at start (`sandbox-exec -p "(version 1)(allow default)" /usr/bin/true`) catches that and a
  missing tool; on failure the feature is off and Auto mode checks as today.
- Risk: Apple may remove the tool. Then the probe fails and the app falls back to the check: slower, never looser.
- Alternatives, none better now: `sandbox_init` from a native helper (same engine, also deprecated, a native build);
  App Sandbox (whole app, fixed at signing); Endpoint Security (an entitlement from Apple; it watches, not confines);
  a Linux VM or container (not the Mac's tools or files).

## 8. Cost

Measured on this Mac, median of n runs (p90 in brackets), in a temp folder:

| Command | No sandbox | Sandbox, empty profile | Sandbox, draft profile |
| --- | --- | --- | --- |
| `zsh -fc true` (n=200) | 2.0 ms (2.4) | 7.6 ms (8.8) | 9.0 ms (10.4) |
| `zsh -fc "ls /usr/bin \| wc -l"` (n=100) | 7.5 ms (8.2) | | 15.7 ms (24.2) |
| `zsh -lc true`, as Silo runs it, system profile only (n=50) | 6.4 ms (9.7) | | 18.3 ms (34.8) |

About 7 to 12 ms per command. A check is a model call: median 0.87 s on Haiku 5.5 and 1.56 s on Opus 5.5
(`classifier.ts`), and about 3.2K uncached tokens through a gateway (`task-efficiency-2.md`). So one sandboxed run
costs about 1% of a check's wait and no tokens.

The 25 checks left in the logged run (`task-efficiency-2.md`, section 2), with the recommended defaults: in the
sandbox, 5 Python edit scripts, 4 heredocs writing to `/tmp`, 3 test runs, 2 `python -c` probes, 2 runs with
`VAR=` in front, 2 server starts and 1 curl to localhost (19); still checked, 3 `gh` calls, 1 cloud CLI call,
1 virtual env and install, 1 `git checkout -b` (6). Loopback off moves 3 back to the check; only a per-session temp
folder moves 4 back. Inferred from the list (assuming the tests need no network), not rerun.

## 9. Tests and build order

**Unit rows** (`test/sandbox.js`): the profile from a folder (escaping, real paths, every rule present, a folder
with spaces and regex characters); detection (samples from `touch`, Python, Node `EPERM`, curl, git
`index.lock`, DNS failures, exit 65, exit 0 with the words in it, exits 2/126/127); the known list; `decideApproval`
rows for each mode with the sandbox on, off, paused and with the check unavailable; the environment filter; a
project file's `sandbox` keys ignored; `protectedWrite` at any depth.

**Integration, macOS, no model**: every "tested" case above, through the real `bash` tool in a temp project.

**Live script on the mock model** (`test/live/sandbox.js`, beside `auto-mode.js`): in Auto mode the mock issues a
heredoc to `/tmp`, a test run, a Python write outside (blocked, then the mock check allows, then the rerun), `git
add` and `npm install` (straight to the check); it asserts the check count, the row marks and the result text. In
Plan mode, a read runs sandboxed. Then the owner's run with a key, measuring checks before and after.

**Before building, test by hand**: `launchctl submit`, `open` and `osascript` under the profile (not run here: each
starts something on the Mac if the profile lets it through).

**Build order** (rough sizes, tests included): 1. profile builder, pure (~250 lines). 2. probe, spawn through
`sandbox-exec`, environment filter, profile baseline (~150). 3. detection and the known list (~150). 4. the new path
in `permissions.ts` and `agent.ts`: sandbox, block, check, rerun (~250). 5. settings, Settings switches, row mark,
`/report` counts (~250). 6. Plan mode's read-only profile (~50). 7. docs, changelog, live script (~200). About 1,300
lines, two or three sessions, then the measured run.

## 10. Questions for the owner

1. **Allow the loosening at all?** Commands whose effects stay in the project and temp folders run with no check,
   project deletes included. Recommended: yes, with `.git` read-only, so history stays safe.
2. **Local ports in the sandbox**, on or off? On lets tests and dev servers work but lets a command reach a local
   database or gateway. Recommended: on, minus a denied list of well-known service ports (5432, 3306, 6379, 27017,
   2375/2376, 9222, 11434) and Silo's own remote-control and sign-in ports.
3. **Temp folders**: all of `/private/tmp` and the user's `/var/folders`, or only a per-session folder?
   Recommended: all, as the guard already treats them (4 of the 25 checks).
4. **`.git` read-only** (git writes keep the check) or writable but for `config` and hooks? Recommended: read-only.
5. **Widen the secret list**, in the guard and the sandbox together: `~/.config/gcloud`, `~/.kube`, `~/.azure`,
   `~/.git-credentials`, `~/.cargo/credentials*`, `~/.terraform.d/credentials*`, shell history files,
   `~/Library/Keychains`, browser profile folders. Recommended: yes.
6. **After a block**: the check and a rerun at once, or back to the model with `outside: true`? Recommended: at once
   for a detected block (one model call fewer), plus `outside: true` for what detection misses.
7. **Known commands skip the doomed first run?** Recommended: yes.
8. **Default**: off for the first release (opt in), or on in Auto mode? Recommended: opt in for one release, on
   after the measured run and a week of use.
9. **Plan mode reads in a read-only sandbox?** Recommended: yes; it only tightens.
10. **Paused Auto mode**: sandboxed commands keep running without a card? Recommended: yes, they are contained.

## Sources

- **Ran here** (scratchpad prototype, temp folders and a fake home, harmless commands): every row marked "tested",
  the timings, the TEST-NET-1 connect (refused at once inside, a 2 s timeout outside), the DNS lookup of
  `example.com` (refused inside, answered outside), the empty unified log, exit 65 on a bad profile.
- **Read**: Silo at `20976ed` (`shell.ts`, `guard.ts`, `permissions.ts`, `auto-rules.ts`, `classifier.ts`, `agent.ts`,
  `reference.md`, `package.json`); `tool-call-comparison.md`, `task-efficiency-2.md` (branch `efficiency-research`);
  Codex `6bfdc75` (`codex-rs/sandboxing/src/seatbelt*`, `denial.rs`, `core/src/tools/orchestrator.rs`,
  `protocol/src/permissions.rs`, `protocol.rs`); DeepSeek Harness `e8f7b93` (`packages/sandbox/*`, `cordis.patch.yml`).
- **Not determined**: whether `launchctl submit`, `open` or `osascript` get out under this profile; whether a
  Seatbelt deny comes before a macOS privacy prompt (testing could have raised one); `defaults write` to a named
  domain (it would write to the real `~/Library/Preferences`); behaviour from inside the packaged, signed app
  rather than a shell; how many real test suites need the network or write outside; Claude Code's own sandbox (not read).
