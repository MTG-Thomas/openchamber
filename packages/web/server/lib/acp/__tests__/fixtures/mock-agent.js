#!/usr/bin/env node
// Minimal ACP stdio agent for tests (the MockLocalAgent fixture from the
// test plan). Handles initialize / session/new / session/prompt / session/cancel.
// A prompt turn emits one assistant text chunk then resolves with end_turn.
//
// Usage: spawned as a subprocess by acp-connection tests. Speaks ACP over
// stdin/stdout using @agentclientprotocol/sdk.

import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map();

const initialize = () => ({
  protocolVersion: acp.PROTOCOL_VERSION,
  agentCapabilities: { loadSession: false },
});

const newSession = () => {
  const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  sessions.set(sessionId, { pendingAbort: null, configOptions: defaultConfigOptions() });
  return { sessionId, configOptions: sessions.get(sessionId).configOptions };
};

// A model select the client can switch via session/set_config_option.
const defaultConfigOptions = () => ([
  {
    type: "select",
    id: "model",
    category: "model",
    name: "Model",
    currentValue: "model-a",
    options: [
      { value: "model-a", name: "Model A", description: null },
      { value: "model-b", name: "Model B", description: null },
    ],
  },
]);

const setConfigOption = (params) => {
  const session = sessions.get(params.sessionId);
  if (!session) throw new Error(`Session ${params.sessionId} not found`);
  session.configOptions = session.configOptions.map((option) => (
    option.id === params.configId ? { ...option, currentValue: params.value } : option
  ));
  return { configOptions: session.configOptions };
};

const prompt = async (params, cx) => {
  const session = sessions.get(params.sessionId);
  if (!session) throw new Error(`Session ${params.sessionId} not found`);
  session.pendingAbort?.abort();
  session.pendingAbort = new AbortController();
  try {
    const promptText = Array.isArray(params.prompt)
      ? params.prompt.filter((block) => block?.type === "text").map((block) => block.text).join("")
      : (typeof params.prompt === "string" ? params.prompt : "");
    // A prompt beginning with `permission:` makes the agent ask the client to
    // approve a tool call, then echo the chosen option so tests can assert the
    // round-trip. Existing behavior is unchanged for other prompts.
    if (promptText.startsWith("permission:")) {
      const response = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "call-perm-1",
          title: "Write to /tmp/acp-permission-target",
          kind: "edit",
          status: "pending",
          locations: [{ path: "/tmp/acp-permission-target" }],
          rawInput: { path: "/tmp/acp-permission-target" },
        },
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      });
      const outcome = response?.outcome?.outcome === "selected" ? response.outcome.optionId : "cancelled";
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `permission:${outcome}` },
        },
      });
      return { stopReason: "end_turn" };
    }
    // One assistant text chunk, matching the prompt-turn notification shape.
    await cx.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello from the mock ACP agent." },
      },
    });
    // Respect cancellation if it arrives during the turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (session.pendingAbort.signal.aborted) return { stopReason: "cancelled" };
    return { stopReason: "end_turn" };
  } finally {
    session.pendingAbort = null;
  }
};

const cancel = (params) => {
  sessions.get(params.sessionId)?.pendingAbort?.abort();
};

// Agent stream: write responses to our stdout, read requests from our stdin.
const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);

acp
  .agent({ name: "mock-acp-agent" })
  .onRequest("initialize", (ctx) => initialize(ctx.params))
  .onRequest("session/new", (ctx) => newSession(ctx.params))
  .onRequest("session/prompt", (ctx) => prompt(ctx.params, ctx.client))
  .onRequest("session/set_config_option", (ctx) => setConfigOption(ctx.params))
  .onNotification("session/cancel", (ctx) => cancel(ctx.params))
  .connect(stream);
