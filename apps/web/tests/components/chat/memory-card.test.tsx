// @vitest-environment jsdom
// OPEND-2745's current product decision supersedes the old memory disclosure
// design. Historical payloads stay valid; no replacement UI is introduced.
import { cleanup, render } from '@testing-library/react';
import { splitOnOdCards } from '@open-design/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { OdCardView } from '../../../src/components/OdCard';

afterEach(cleanup);
const card = {
  kind: 'memory-applied' as const, summary: '已记住 3 条偏好',
  used: [
    { id: 'm1', type: 'project' as const, name: '商品卡做成共享组件' },
    { id: 'm2', type: 'feedback' as const, name: '圆角统一 12px' },
    { id: 'm3', type: 'user' as const, name: '不要暖色背景' },
  ],
};

describe('retired ChatPanel memory presentation', () => {
  it('does not show count, entries or an expandable control', () => {
    const { container } = render(<OdCardView card={card} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('still decodes historical memory payloads so they cannot fall through as XML', () => {
    const markup = `<od-card type="memory-applied">${JSON.stringify(card)}</od-card>`;
    const segments = splitOnOdCards(markup);
    expect(segments).toHaveLength(1);
    const segment = segments[0];
    if (!segment || segment.kind !== 'card') throw new Error('Historical memory protocol no longer recognized');
    expect(segment.card).toEqual(card);
    const { container } = render(<OdCardView card={segment.card} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('does not mutate the stored references while suppressing their notification', () => {
    const original = structuredClone(card);
    const { container } = render(<OdCardView card={card} />);
    expect(card).toEqual(original);
    expect(container).toBeEmptyDOMElement();
  });
});
