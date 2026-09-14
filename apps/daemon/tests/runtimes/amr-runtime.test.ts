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

it('extends the first-output window only for model-only calls', () => {
  expect(amrFirstOutputTimeoutMs('none', 120_000)).toBe(600_000);
  for (const runtime of ['opencode', 'pi', 'codex', 'claude', 'dsh', undefined] as const) {
    expect(amrFirstOutputTimeoutMs(runtime, 120_000)).toBe(120_000);
  }
});
