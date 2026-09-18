import { describe, expect, it } from 'vitest';
import { splitShellCards } from '../../../src/runtime/chat/split-shell-cards';

const payload = { summary: 'Preserve `<od-demo>text</od-demo>`', fields: [] };
const card = `<od-card type="task-brief">${JSON.stringify(payload)}</od-card>`;

describe('shell card decoding', () => {
  it('preserves a different tag sharing the od-card prefix while streaming', () => {
    const text = 'Before <od-card-example> keep this normal explanation.';
    expect(splitShellCards(text, true)).toEqual([{ kind: 'text', text }]);
  });

  it('keeps Markdown-like content inside a real card payload intact', () => {
    expect(splitShellCards(card, false)).toEqual([
      { kind: 'card', card: { kind: 'task-brief', ...payload }, raw: card },
    ]);
  });

  it('does not let a backtick inside one card payload turn the next card into code', () => {
    const firstPayload = { summary: 'Use `brand', fields: [] };
    const secondPayload = { summary: 'Applied palette', used: [{ type: 'rule', name: 'Palette' }] };
    const first = `<od-card type="task-brief">${JSON.stringify(firstPayload)}</od-card>`;
    const second = `<od-card type="memory-applied">${JSON.stringify(secondPayload)}</od-card>`;

    expect(splitShellCards(`${first}\n${second}\ntail\``, false)).toEqual([
      { kind: 'card', card: { kind: 'task-brief', ...firstPayload }, raw: first },
      { kind: 'text', text: '\n' },
      { kind: 'card', card: { kind: 'memory-applied', ...secondPayload }, raw: second },
      { kind: 'text', text: '\ntail`' },
    ]);
  });

  it('does not let an unclosed tag quoted in code consume a later real card', () => {
    const quoted = '`<od-card type="task-brief">`\n\n';
    const segments = splitShellCards(quoted + card, true);
    expect(segments[0]).toEqual({ kind: 'text', text: quoted });
    expect(segments[1]?.kind).toBe('card');
  });

  // Product ruling (user, 2026-09-18): a closed card whose JSON does not parse
  // is not shown at all — raw protocol markup reads as garbage to the user.
  it('drops a malformed complete block instead of painting it beside valid cards', () => {
    const malformed = '<od-card type="task-brief">invalid JSON</od-card>';
    const segments = splitShellCards(`${malformed}\n${card}`, false);
    expect(segments).toEqual([
      { kind: 'text', text: '\n' },
      { kind: 'card', card: { kind: 'task-brief', ...payload }, raw: card },
    ]);
  });

  it('keeps the prose around a dropped malformed block', () => {
    const malformed = '<od-card type="memory-applied">{"used":[],}</od-card>';
    expect(splitShellCards(`Before.\n${malformed}\nAfter.`, false)).toEqual([
      { kind: 'text', text: 'Before.\n\nAfter.' },
    ]);
  });

  // "Malformed" is not "still being written": an opener with no close tag yet is
  // withheld while streaming so a later delta can complete it into a real card.
  it('withholds an unclosed opener while streaming instead of dropping the turn', () => {
    const partial = 'Reading your preferences.\n\n<od-card type="memory-applied">{"sum';
    expect(splitShellCards(partial, true)).toEqual([
      { kind: 'text', text: 'Reading your preferences.\n\n' },
    ]);
  });
});
