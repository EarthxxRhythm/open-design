import { expect, it } from 'vitest';
import { amrAgentDef, amrFirstOutputTimeoutMs } from '../../src/runtimes/defs/amr.js';
import { agentSessionStorageKey } from '../../src/runtimes/amr-session-key.js';

it('selects the AMR harness per invocation without changing the default', () => {
  expect(amrAgentDef.buildArgs('', [])).toEqual(['agent', 'run', '--runtime', 'opencode']);
  expect(amrAgentDef.buildArgs('', [], [], { amrRuntime: 'pi' }))
    .toEqual(['agent', 'run', '--runtime', 'pi']);
  expect(amrAgentDef.buildArgs('', [], [], { amrRuntime: 'opencode' }))
    .toEqual(['agent', 'run', '--runtime', 'opencode']);
  expect(amrAgentDef.buildArgs('', [])).toEqual(['agent', 'run', '--runtime', 'opencode']);
});

it('keeps legacy OpenCode handles separate from Pi and other agents', () => {
  expect(agentSessionStorageKey('amr')).toBe('amr');
  expect(agentSessionStorageKey('amr', 'opencode')).toBe('amr');
  expect(agentSessionStorageKey('amr', 'pi')).toBe('amr:pi');
  expect(agentSessionStorageKey('pi')).toBe('pi');
});

it.each(['codex', 'claude', 'dsh', 'none'] as const)('passes %s through and keeps its own session namespace', (runtime) => {
  expect(amrAgentDef.buildArgs('', [], [], { amrRuntime: runtime }))
    .toEqual(['agent', 'run', '--runtime', runtime]);
  expect(agentSessionStorageKey('amr', runtime)).toBe(`amr:${runtime}`);
});

// Every AMR runtime waits on the same provider before the first token, and a
// harness adds its own spawn/resume/replay on top of that wait rather than
// shortening it. The old split gave the harnesses a fifth of the model-only
// budget, which cost the harness evaluation its heaviest prompts to a
// "stalled without emitting a first output for 120s" with ttft 0.
it('gives every AMR runtime the same first-output window', () => {
  for (const runtime of ['none', 'opencode', 'pi', 'codex', 'claude', 'dsh', undefined] as const) {
    expect(amrFirstOutputTimeoutMs(runtime, 120_000)).toBe(600_000);
  }
});
