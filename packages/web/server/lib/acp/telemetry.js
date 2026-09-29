// ACP telemetry event definitions (telemetry.md). OpenChamber has no shared
// analytics sink today, so these are no-op emitters that document the event
// contract and centralize the call sites. When a sink is introduced, replace
// the emit body with the real dispatcher; the event names and properties stay
// stable. Privacy: no prompt/reply/tool content or command lines are logged;
// agent identity is hashed.

const hashAgentId = (agentId) => {
  if (typeof agentId !== 'string' || agentId.length === 0) return 'unknown';
  let h = 0;
  for (let i = 0; i < agentId.length; i++) {
    h = (h * 31 + agentId.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(16)}`;
};

const emit = (name, properties) => {
  // No-op until a telemetry sink is wired. Centralizing here means call sites
  // do not change when the sink lands.
  if (typeof process !== 'undefined' && process.env.OPENCHAMBER_ACP_TELEMETRY_DEBUG === '1') {
    console.log(`[acp:telemetry] ${name}`, properties);
  }
};

export const acpTelemetry = {
  featureFlag: (enabled) => emit('acp.feature_flag', { enabled: !!enabled }),
  agentSelected: (backend, agentId) =>
    emit('acp.agent.selected', { backend, agentIdHash: hashAgentId(agentId) }),
  initializeStart: (agentId) => emit('acp.initialize.start', { agentIdHash: hashAgentId(agentId) }),
  initializeResult: (agentId, outcome, durationMs, errorCode) =>
    emit('acp.initialize.result', { agentIdHash: hashAgentId(agentId), outcome, durationMs, errorCode }),
  sessionCreated: (agentId) => emit('acp.session.created', { agentIdHash: hashAgentId(agentId) }),
  promptSubmitted: (agentId) => emit('acp.prompt.submitted', { agentIdHash: hashAgentId(agentId) }),
  turnCompleted: (agentId, stopReason, durationMs) =>
    emit('acp.turn.completed', { agentIdHash: hashAgentId(agentId), stopReason, durationMs }),
  transportError: (phase, errorCode) => emit('acp.transport.error', { phase, errorCode }),
};
