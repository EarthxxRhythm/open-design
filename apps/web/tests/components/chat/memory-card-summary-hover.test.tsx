// @vitest-environment jsdom
// The memory summary itself was retired by OPEND-2745. The former hover/CSS
// oracle no longer describes a reachable control; it must not be restored.
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { OdCardView } from '../../../src/components/OdCard';

afterEach(cleanup);
it('does not leave a focusable or hoverable summary for a hidden memory card', () => {
  const { container } = render(<OdCardView card={{
    kind: 'memory-applied', summary: '已记住 1 条偏好',
    used: [{ id: 'm1', type: 'rule', name: '圆角统一 12px' }],
  }} />);
  expect(container.querySelector('summary, details, button, [tabindex]')).toBeNull();
  expect(container).toBeEmptyDOMElement();
});
