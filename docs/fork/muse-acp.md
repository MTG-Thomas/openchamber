# Muse Code through ACP

Install/authenticate the existing `muse-acp` adapter on the execution host.
This fork adds no Muse protocol code. The adapter verified here is version 0.7.0.

For an isolated web spike:

```bash
OPENCHAMBER_DATA_DIR=/tmp/openchamber-acp-spike \
OPENCHAMBER_ACP_ENABLED=1 \
OPENCHAMBER_ACP_COMMAND=/absolute/path/to/muse-acp \
OPENCHAMBER_ACP_AGENT_NAME='Muse Code' \
OPENCHAMBER_ACP_CWD=/tmp \
OPENCHAMBER_RELAY_HOST=off \
bun packages/web/server/index.js --port 3091
```

Build first with `VITE_OPENCHAMBER_MULTIRUNTIME=1 bun run build`. Use
Settings → Agent Backend to select the configured Muse agent. OpenCode stays
the default until selected. The arguments field takes a JSON string array, for
example `["--flag", "a value"]`; arguments are passed directly to spawn, never
through a shell. Keep credentials in the adapter's existing authentication setup.
The server publishes executable/arguments to authenticated clients but never
publishes the subprocess environment.

On an iPhone, pair with that server using the existing direct/relay flow.
The server-configured agent is discovered automatically; selecting it creates a
session on that host. The executable path belongs to the server, not the phone.
Model selection appears when the agent advertises model options. Permission
cards are driven by ACP requests; an agent configured to allow all tools will
not ask. Cancelling a turn acts only on the selected session's owning host.
Muse reports reminder child-session completion as another `tool_call` snapshot
with the same ID. The translator applies its completed/failed status to the
existing card; it does not start a second tool or leave a completed reminder
running. Ordinary `tool_call_update` output remains incremental.

The opt-in HTTP/SSE acceptance script creates a new session on a running test
server and sends a short prompt; do not aim it at an unrelated active agent:

```bash
ACP_SMOKE_URL=http://127.0.0.1:3091 bun scripts/fork/acp-smoke.mjs
```

For a protected test instance, supply `ACP_SMOKE_TOKEN` in the environment.
Only event counts are logged. A timeout cancels its own turn. The test does
not assert tools must occur: tool use depends on the agent. The Muse UI run
observed text and tool activity; deterministic ACP fixtures verify permissions,
cancellation and reconnect/replay behavior.

Current scope: one active ACP agent per server, text prompts, translated tool
cards and advertised model options. Images, agent slash commands, OpenCode
session mutations, cross-host operations and arbitrary ACP network transports
are outside this spike. History replay depends on the agent; full-fidelity
cross-process tool history is not promised. iOS direct/relay pairing, Keychain,
APNs delivery, background/resume and permission taps still require native
simulator/device verification. The macOS CI job builds the simulator app; it
does not prove those runtime flows.
