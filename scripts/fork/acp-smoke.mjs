// Opt-in acceptance against a running, isolated OpenChamber server.
// Logs event counts only, never prompts, replies, credentials or tool arguments.
import { setTimeout as delay } from 'node:timers/promises';
const origin = new URL(process.env.ACP_SMOKE_URL || 'http://127.0.0.1:3091');
const headers = new Headers({ 'Content-Type': 'application/json' });
if (process.env.ACP_SMOKE_TOKEN) headers.set('Authorization', `Bearer ${process.env.ACP_SMOKE_TOKEN}`);
const call = async (path, body) => {
  const options = { method: body ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(20000) };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(new URL(path, origin), options);
  const data = await response.json();
  if (!response.ok) throw new Error(`ACP smoke request failed (${response.status}): ${data.error || path}`);
  return data;
};
const status = await call('/api/agent/acp/status');
if (!status.enabled || !status.agent) throw new Error('Configure and enable an ACP agent on this server first');
const config = status.agent;
const created = await call('/api/agent/acp/initialize', { command: config.command, args: config.args,
  agentId: config.id, name: config.name, cwd: process.env.ACP_SMOKE_CWD || '/tmp', directory: process.env.ACP_SMOKE_CWD || '/tmp' });
const sessionID = created.sessionID;
const events = new Map();
const stop = new AbortController();
let finished = false;
const stream = (async () => {
  const response = await fetch(new URL('/api/event', origin), { headers, signal: stop.signal });
  if (!response.ok || !response.body) throw new Error(`SSE unavailable (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE closed before acceptance finished');
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const json = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!json) continue;
        const event = JSON.parse(json);
        if (event.data?.sessionID !== sessionID) continue;
        events.set(event.type, (events.get(event.type) || 0) + 1);
        if (event.type === 'session.execution.succeeded') finished = true;
        if (event.type === 'session.execution.failed') throw new Error('ACP turn failed');
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
})();
let streamError;
void stream.catch(error => { if (!stop.signal.aborted) streamError = error; });
try {
  await delay(500);
  await call('/api/agent/acp/session/prompt', { sessionID, agentId: config.id,
    userMessageId: `msg_smoke_${Date.now()}`, text: 'Reply with exactly: OpenChamber ACP smoke passed. Do not modify any files.' });
  const deadline = Date.now() + 120000;
  while (!finished && !streamError && Date.now() < deadline) await delay(250);
  if (streamError) throw streamError;
  if (!finished) {
    await call('/api/agent/acp/session/cancel', { sessionID, agentId: config.id });
    throw new Error('ACP smoke timed out; its turn was cancelled');
  }
  if (!events.has('session.text.delta')) throw new Error('No text streamed over SSE');
  console.log(JSON.stringify({ initialized: true, completed: true, events: Object.fromEntries(events) }));
} finally { stop.abort(); await stream.catch(() => {}); }
