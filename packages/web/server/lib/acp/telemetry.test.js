import { describe, expect, it } from 'vitest';
import { acpTelemetry } from './telemetry.js';

// Telemetry emitters are no-ops until a sink is wired; these tests verify the
// contract (no throw, hashed agent id, debug-mode passthrough) and that call
// sites are stable.

describe('acpTelemetry', () => {
  it('every emitter is a no-op that does not throw', () => {
    expect(() => {
      acpTelemetry.featureFlag(true);
      acpTelemetry.agentSelected('acp', 'agent-1');
      acpTelemetry.initializeStart('agent-1');
      acpTelemetry.initializeResult('agent-1', 'success', 42);
      acpTelemetry.initializeResult('agent-1', 'error', 0, 'spawn_failed');
      acpTelemetry.sessionCreated('agent-1');
      acpTelemetry.promptSubmitted('agent-1');
      acpTelemetry.turnCompleted('agent-1', 'end_turn', 100);
      acpTelemetry.transportError('prompt', 'timeout');
    }).not.toThrow();
  });

  it('hashes the agent id (never logs it in cleartext)', () => {
    // Debug mode emits a console.log we can capture via a spy.
    const logs = [];
    const orig = console.log;
    console.log = (msg, props) => logs.push({ msg, props });
    process.env.OPENCHAMBER_ACP_TELEMETRY_DEBUG = '1';
    try {
      acpTelemetry.agentSelected('acp', 'my-secret-agent');
    } finally {
      console.log = orig;
      delete process.env.OPENCHAMBER_ACP_TELEMETRY_DEBUG;
    }
    const entry = logs.find((l) => l.msg === '[acp:telemetry] acp.agent.selected');
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry.props)).not.toContain('my-secret-agent');
    expect(entry.props.agentIdHash).toMatch(/^h[0-9a-f]+$/);
  });

  it('handles a missing agent id gracefully', () => {
    expect(() => acpTelemetry.agentSelected('acp', undefined)).not.toThrow();
  });
});
