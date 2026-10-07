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

## Implemented spike contracts

`OPENCHAMBER_ACP_ENABLED=1` enables ACP on a host; OpenCode stays the draft
default. Server configuration is discoverable by authenticated clients through
`/api/agent/acp/status`. ACP settings persist per runtime. A selected draft backend
never decides who owns an existing session. ACP control requests include agent
and session identity, and refuse obsolete owners. One ACP agent process/turn is
supported per server; creating another session while busy returns a visible error.

Build with `VITE_OPENCHAMBER_MULTIRUNTIME=1` to show the aggregate tree above
the existing foreground sidebar (or inside the mobile sessions drawer). Desktop
uses its configured hosts. Capacitor uses existing saved device identities,
Keychain tokens and direct/relay probes. Browser exposes its current instance.
The registry holds summaries, opens no terminals or MCP project locations, and
uses a separate authenticated HTTP/SSE transport for each host. Failure retains
prior summaries with a retry control. Suspension closes client observations;
resume reloads authoritative snapshots. A server turn continues while iOS sleeps.

OpenCode-only permission automation, follow-up queues, dispatch results and
message search receive only events owned by OpenCode. ACP tools and permission
requests cannot trigger those consumers with a foreign native ID.

ACP events use the existing event hub, numbered replay and supplemental global
SSE stream, so native clients do not need a desktop-only event path. Notification
registration records the saved-host identity for each mobile device; each push
returns that device's identity and the session backend. The legacy iOS widget
`runtimeKey` field carries the same recipient identity, so another host's push
cannot mark a colliding foreground widget row unread. Desktop notifications and
copied message links include the owner. Links can activate an already-configured
runtime; they cannot import endpoints or credentials. Legacy links remain valid.

Enterprise mode refuses ACP at the server boundary because agent provider
configuration is outside managed OpenCode. Settings displays the reason.

`fork-upstream-sync.yml` runs weekly after landing on the fork default branch.
It merges upstream into a generated integration branch, reports overlapping patch
files, and creates/updates a fork PR. Conflict branches contain only a report;
there is no automatic semantic resolution. Successful candidates explicitly
invoke `fork-checks.yml`, since PRs created by GITHUB_TOKEN do not trigger normal
PR workflows. Shared checks use GitHub-hosted Linux; the same fork checks also
build the iOS simulator on macOS. Neither workflow automatically merges.

## Remaining limits

Runtime keys currently follow each client's existing saved-host IDs (and the
browser's URL-derived instance key). A qualified desktop link therefore needs
an equivalent configured owner on the receiving client; it cannot automatically
map a desktop host ID onto an independently paired iPhone. Mobile pushes avoid
that ambiguity by returning the receiving device's own saved-host ID. Portable
server-identity aliasing is a follow-up, not an endpoint-discovery mechanism.

The aggregate index and reference format support equal native IDs across hosts
and backends. Existing foreground session stores still use native IDs within
one active runtime. ACP-native IDs colliding with OpenCode IDs on the same host
are refused with an explicit conflict error before reads or ACP controls; opening
both requires an aliasing boundary. The spike does not migrate all OpenCode
foreground stores. If OpenCode is unavailable, ownership verification fails
visibly rather than guessing the backend. ACP agent selection is currently
one process/agent per server. These are explicit limits of the spike, not a
claim that every backend capability or identity migration is finished.

## Verification ledger

Local Linux verification on OpenChamber 2.1.1 / mobile package 1.13.2:

- Full UI suite: 766/766 files. SDK: 22/22; VS Code: 59/59; Electron:
  35/35; scripts: 10/10. Web on Node 24: 380 passed, 9 skipped files,
  6,573 passing tests after the ownership and notification fixes.
- Workspace type-check and lint pass (six existing UI lint warnings).
  Full workspace build and refreshed web/mobile assets pass.
- Two real HTTP fixture servers verify separate credentials, equal native
  session/project IDs, owner activation and isolated host failure.
- Real `muse-acp` 0.7.0: OpenChamber HTTP create/prompt/global SSE complete
  successfully with streamed text and six tool calls. Built desktop web UI
  renders tool activity; a live cancel request succeeds. Hosted mobile at
  390×844 loads the ACP transcript after navigation, sends a fresh prompt and
  renders its streamed reply/tools with no horizontal overflow.
- Deterministic ACP fixtures cover permission replies, cancellation,
  numbered event replay, obsolete owners, busy-agent refusal, enterprise
  refusal and ambiguous backend IDs. APNs fixtures verify recipient-specific
  runtime ownership.
- Upstream intake tests use real isolated Git repositories and stub only the
  external upstream URL/GitHub command boundary. Clean merges dispatch checks;
  semantic conflicts produce a report without integrating conflicted code.
- Dead-code review retains public identity primitives and the dynamically
  launched ACP fixture. Targeted anti-slop checks pass for the newly authored
  identity/index/connection/ownership/automation modules. The harvested ACP
  code retains existing manual wire-shape checks; these are not a claim of a
  repository-wide anti-slop cleanup.

GitHub fork checks include Linux shared gates and the macOS simulator build.
Native iOS runtime flows remain unverified locally: direct/relay pairing,
Keychain, APNs delivery/taps, permissions, suspend/resume and simultaneous
saved-host connections require a simulator/device acceptance run. Hosted
Chromium mobile proof does not establish WKWebView behavior.

Fork repository settings disable the inherited `pr checks` (`oc-review.yml`)
and `pr-review` workflows: they require upstream Blacksmith runners and review
app secrets. `fork-checks.yml` preserves the shared test/type/lint/build gates,
changelog check and Electron packaging/updater tests on available runners.
Actions may create integration PRs; default token permissions stay read-only,
and write scopes are declared only in the intake workflow.

Reviewed visual evidence: [desktop web](evidence/acp-desktop.png) and
[hosted mobile](evidence/acp-mobile.png). Captures exclude unrelated session
lists. Mobile proof is Chromium, not the native iOS shell.
