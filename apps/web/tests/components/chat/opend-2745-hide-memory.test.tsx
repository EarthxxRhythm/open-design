// @vitest-environment jsdom
// OPEND-2745 was renamed to “去掉记忆” after the earlier host-card ownership
// workaround. Hide the ChatPanel presentation, not the stored memory or prose.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantMessage } from '../../../src/components/AssistantMessage';
import { I18nProvider } from '../../../src/i18n';
import { en } from '../../../src/i18n/locales/en';
import { memoryWrittenCardContent } from '../../../src/runtime/useMemoryWrittenCard';
import type { ChatMessage } from '../../../src/types';

const KEY = 'a7f3c91ed2b40561';
const SUMMARY = 'OPEND2745_HIDDEN_MEMORY_SUMMARY';
const ENTRY = 'OPEND2745_HIDDEN_STORED_RULE';
const CARD = memoryWrittenCardContent({
  key: 'extraction-2745', count: 1,
  entries: [{ id: 'saved-rule-2745', type: 'rule', name: ENTRY }],
}, SUMMARY);
const BEFORE = 'Visible answer before the memory notification.';
const AFTER = 'Visible answer after the memory notification.';

function show(message: ChatMessage, streaming = false) {
  return render(<I18nProvider initial="en"><AssistantMessage
    message={message} streaming={streaming} projectId="project-2745"
    conversationId="conversation-2745" isLast
  /></I18nProvider>);
}
function openRecord(container: HTMLElement) {
  const record = container.querySelector<HTMLDetailsElement>('[data-testid="assistant-flow"] details');
  if (record && !record.open) {
    record.open = true;
    fireEvent(record, new Event('toggle', { bubbles: false }));
  }
}
function host(content = CARD): ChatMessage {
  return { id: 'host-memory-2745', role: 'assistant', content,
    events: [{ kind: 'text', text: content }], agentId: 'claude',
    agentName: 'Claude', createdAt: 1000 };
}
function expectMemoryHidden(container: HTMLElement) {
  expect(container.querySelector('[data-od-card="memory-applied"]')).toBeNull();
  expect(container.textContent).not.toContain(SUMMARY);
  expect(container.textContent).not.toContain(ENTRY);
  expect(container.textContent).not.toContain('<od-card');
  expect(container.textContent).not.toContain('"used"');
}
afterEach(() => { cleanup(); window.localStorage.clear(); });

describe.each(['shell', 'prose'] as const)('OPEND-2745 hides memory in %s', (lane) => {
  it.each([false, true])('history=%s retains neighboring answer without memory UI or raw payload', async (history) => {
    const text = `${BEFORE}\n\n${CARD}\n\n${AFTER}`;
    const content = lane === 'shell'
      ? `${text}${history ? `\n<od-done key="${KEY}"/>Delivered.` : ''}`
      : `Working.\n<od-done key="${KEY}"/>${text}`;
    const message: ChatMessage = { id: 'real-memory-turn', role: 'assistant', content,
      events: [{ kind: 'done_key', key: KEY }, { kind: 'text', text: content }],
      agentId: 'claude', agentName: 'Claude', runId: 'real-run-2745',
      runStatus: history ? 'succeeded' : 'running', createdAt: 1000, startedAt: 1000,
      ...(history ? { endedAt: 2000 } : {}),
    };
    const original = structuredClone(message);
    const view = show(message, !history);
    openRecord(view.container);
    await waitFor(() => expect(view.container.textContent).toContain(BEFORE));
    expect(view.container.textContent).toContain(AFTER);
    expectMemoryHidden(view.container);
    expect(message).toEqual(original); // Presentation must not erase the transcript.
  });
});

it('hides a historical host-only memory message without leaving a phantom assistant row', () => {
  const message = host();
  const original = structuredClone(message);
  const view = show(message);
  expectMemoryHidden(view.container);
  expect(view.container.querySelector('[data-assistant-message-id="host-memory-2745"]')).toBeNull();
  expect(message).toEqual(original);
});

it('retains real host prose on both sides of a memory notification', () => {
  const view = show(host(`${BEFORE}\n\n${CARD}\n\n${AFTER}`));
  expect(view.container.textContent).toContain(BEFORE);
  expect(view.container.textContent).toContain(AFTER);
  expectMemoryHidden(view.container);
});

it('retains a real completed run even when its only prose was the memory card', () => {
  const view = show({ ...host(), id: 'real-completed-2745', runId: 'completed-run',
    runStatus: 'succeeded', startedAt: 1000, endedAt: 2000 });
  expect(view.getByText(en['assistant.doneLabel'])).toBeTruthy();
  expectMemoryHidden(view.container);
});

it('preserves explicitly quoted protocol examples as ordinary code', () => {
  const view = show(host(`${BEFORE}\n\n\`\`\`xml\n${CARD}\n\`\`\``));
  expect(view.container.querySelector('code')?.textContent).toBe(CARD);
  expect(view.container.textContent).toContain(BEFORE);
  expect(view.container.querySelector('[data-od-card="memory-applied"]')).toBeNull();
});
