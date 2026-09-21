import { describe, expect, it } from 'vitest';
import { injectCommentBridge } from '../../src/runtime/comment-bridge';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

const inspectMessages = [
  'od:inspect-set', 'od:inspect-reset', 'od:inspect-extract', 'od:inspect-replay', 'od:inspect-overrides',
];
const commentMessages = [
  'od:comment-mode', 'od:comment-target', 'od:comment-targets', 'od:comment-active-target-update', 'od:preview-scroll', 'od:pod-stroke',
];

describe('share-safe comment bridge', () => {
  it('contains the frozen comment protocol but none of the five inspect capabilities', () => {
    const bridge = injectCommentBridge('<main data-od-id="hero">Hero</main>', true);
    for (const type of commentMessages) expect(bridge).toContain(type);
    for (const type of inspectMessages) expect(bridge).not.toContain(type);
  });

  it('keeps the production srcdoc on its original full comment+inspect composition', () => {
    const full = buildSrcdoc('<main data-od-id="hero">Hero</main>', { commentBridge: true, inspectBridge: true });
    expect(full).toContain('data-od-selection-bridge');
    for (const type of inspectMessages) expect(full).toContain(type);
  });
});
