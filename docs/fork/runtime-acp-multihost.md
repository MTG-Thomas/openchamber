# Runtime, backend, and session ownership

This fork starts from upstream `733fa61a42c1e861e8e1cad0d7fd6d1e844f8723`
(OpenChamber 2.1.1). Host location and agent backend are independent.
OpenCode remains the default. No OpenCode protocol rewrite is required.

A runtime ID names one configured OpenChamber instance. It survives endpoint,
LAN/relay, and authentication changes. A backend ID names an agent configuration
on that instance (`opencode` or `acp:<configuration-id>`). A session reference
contains runtime ID, backend ID, native session ID, and optional project ID.
`lib/runtime-identity.ts` owns the contract and tuple keys. A project move does
not change a session key. URLs carry ownership as `runtime`, `backend`, and
optional `project` query parameters. These contain no endpoints or credentials.
Legacy links keep their existing active-instance meaning. Qualified links must
never be opened against a different owner merely because a native ID matches.

## State audit

| State | Owner and scope | Boundary to preserve |
| --- | --- | --- |
| Language, window layout, accessibility | Client-global | No host credentials in UI preferences |
| Connections, health, transport, reconnect generations | Runtime | Stable saved-host/device ID, not URL |
| Project IDs, paths, worktrees, filesystem and terminals | Runtime + project | Equal paths on different hosts are distinct |
| Providers, models, commands, capabilities, agent configuration | Runtime + backend | Do not use a global ACP selection for an existing session |
| Messages, tool calls, permissions, pending prompt, resume | Runtime + backend + session | Explicit owner for every action and delayed completion |
| Pins, folders, selected session, project collapse state | Runtime; backend-qualified session keys | Existing runtime-scoped storage stays compatible |
| Notifications, deep links, navigation history | Session reference | No lookup by bare ID across hosts |
| Server settings, ACP transcript/registry | Owning instance data directory | Never move authoritative sessions to the client index |

Existing stores reset when the foreground runtime changes. Preserve that path
for OpenCode. The new index holds summaries from several owners separately;
it does not make existing foreground stores authoritative for background hosts.
Failed/partial reads preserve known rows and expose stale/error status. Late
responses from a retired connection cannot replace a newer owner's state.

## Runtime behavior

| Surface | Intended behavior |
| --- | --- |
| Web | ACP runs on server; existing authenticated HTTP and event pipeline |
| Electron | Same in-process server ACP backend; global index uses configured hosts |
| VS Code | Explicit unsupported ACP unless its bridge implements the owning routes |
| Hosted mobile | Same server backend and shared UI; no native process |
| Capacitor iOS/Android | ACP on paired server only; SSE and relay remain supported; saved device identity survives LAN/relay changes |

On iOS, a saved host is not a local execution runtime. Suspension stops client
observation, not the server turn. Resume must reload authoritative state before
claiming idle, completing permissions, or removing rows. A permission reply must
carry the original session owner even after foreground host changes. Tokens stay
in the existing secure connection store. Deep links cannot import a host or
credentials. Native simulator/device testing requires macOS/Xcode; Linux web
and transport tests do not prove native compatibility.

## Contributor assessment

Verified 2026-10-07 using Git refs and source diffs:

- `TomzxForks/openchamber:feat/2010-acp-support`, `1fd2e2a69`, is older
  incremental work from July/August, with 91 changed files, extensive `.sdlc`
  artifacts and 1,583 lockfile lines touched.
- `features/2010-acp-support`, `8e085093d`, consolidates the backend into one
  September commit: 65 files, transport, translation, tools, permission hooks,
  model selection, settings, and event fanout. Prefer this lineage.
- [Contributor PR #4](https://github.com/TomzxForks/openchamber/pull/4), head
  `d01692f33`, rebases that implementation and fixes project/session overlays,
  older-session routing, spawn errors, serialized history loading, and instance
  data-directory config. Harvest its transport and fixes selectively. It still
  uses one process/active backend globally, and notes stale availability replies,
  text-only history replay, and load timeout isolation gaps. Those are not
  acceptable ownership rules for the multi-host index.

[ACP issue #2010](https://github.com/openchamber/openchamber/issues/2010) is closed
as not planned following the OpenCode v2 move. [Sidebar issue #1412](https://github.com/openchamber/openchamber/issues/1412)
is open and accepted. Upstreamable means technically general, not accepted for
merge upstream. Keep ACP available in our fork without assuming upstream intake.

## Patch queue and acceptance

1. Identity and ownership contracts. Collision and serialization tests.
2. Qualified navigation. Legacy behavior, complete-owner validation, wrong-host
   refusal, iOS notification/deep-link parsing.
3. ACP stdio transport and server lifecycle, harvested with original authorship.
   Initialize, create, text/tool streaming, cancel, permissions, visible errors.
4. Backend configuration and selection, scoped per runtime; existing sessions
   route by metadata/ref, never by the backend selected for new sessions.
5. Runtime registry and summary index. Independent connections, stale generation
   rejection, partial failure, reconnect and app-resume handling.
6. Unified sidebar. Runtime/project/session tree and owner-qualified activation;
   desktop and mobile drawers share the index, preserve foreground stores.
7. Muse configuration and validation. `muse-acp` executable, no Muse protocol code.
8. Upstream integration automation and final CI evidence.

Each slice must have its own commit or PR. Run package tests/checks for local
changes and workspace checks/builds for shared contracts and dependencies.
Required live proof: Muse session create, streamed text, rendered tool call,
cancel, permission response, reload/revisit; two hosts with identical IDs and
one disconnected host; iOS direct and relay flows, background/resume and tap
routing. Report untested environments explicitly.

## Upstream intake

Fetch `upstream/main` into `upstream-sync/integration`, integrate our patch stack,
then open an integration PR to our `main`. Retain the patch-point file inventory
and report overlapping upstream changes/conflicts. Never resolve semantic
conflicts automatically. Run frozen install, test, type-check, lint and build.
No automated merge until the resulting candidate has the normal review gates.

Generally upstreamable: identity types, qualified links, instance-scoped storage,
notification routing, narrow backend seams, ACP and the unified index/sidebar.
Fork-specific: Muse examples, fork integration scheduling and our patch inventory.
