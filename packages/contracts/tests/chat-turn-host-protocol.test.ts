import { describe, expect, it } from 'vitest';

import { renderChatTurnHostProtocolInstructions } from '../src/prompts/chat-turn-host-protocol.js';

const KEY = '0123456789abcdef';

describe('chat turn host protocol', () => {
  it('renders the same keyed done, next-step, and focus protocol for ordinary chat', () => {
    const result = renderChatTurnHostProtocolInstructions(KEY);

    expect(result.doneMarker).toContain(`<od-done key="${KEY}"/>`);
    expect(result.nextSteps).toContain(`<od-next key="${KEY}" value="Add an orders list page"/>`);
    expect(result.nextSteps).not.toContain('</od-next>');
    expect(result.artifactFocus).toContain(`<od-focus key="${KEY}"`);
    expect(result.text).not.toContain('OD Next host handoff gate');
  });

  it('gates first-round markers on a round that wrote the deliverable itself', () => {
    const result = renderChatTurnHostProtocolInstructions(KEY, 'od_next_request');

    expect(result.text).toContain('only when this round wrote the deliverable itself');
    expect(result.text).toContain('A planning round that ends with the plan and the design notes');
    expect(result.text).toContain('<question-form>');
    expect(result.text).not.toContain('outcome=completed');
    expect(result.text).toContain(`<od-done key="${KEY}"/>`);
  });

  it('gates build-round markers on a finished build and emits nothing without a key', () => {
    const result = renderChatTurnHostProtocolInstructions(KEY, 'od_next_production');

    expect(result.text).toContain('when the build is done and every required deliverable is written');
    expect(result.text).toContain('When the build could not finish');
    expect(result.text).not.toContain('inputStage=production');
    expect(result.text).toContain(`<od-next key="${KEY}" value="Add an orders list page"/>`);
    expect(renderChatTurnHostProtocolInstructions('', 'od_next_production')).toEqual({
      doneMarker: '',
      nextSteps: '',
      artifactFocus: '',
      text: '',
    });
  });
});
