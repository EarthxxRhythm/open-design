// @vitest-environment jsdom
/**
 * Historical host notifications must never own a run. OPEND-2745's later
 * product decision also removes the memory UI itself; keep the real-run and
 * BYOK-placeholder guards while replaying unchanged historical messages.
 */

// jsdom 没有 HTMLElement.prototype.scrollTo —— ChatPane 的滚动逻辑会碰它。
if (typeof HTMLElement.prototype.scrollTo !== 'function') {
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (typeof options === 'object' && options !== null) {
      if (options.top !== undefined) this.scrollTop = options.top;
      if (options.left !== undefined) this.scrollLeft = options.left;
    }
  };
}

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatPane } from '../../../src/components/ChatPane';
import { AssistantMessage } from '../../../src/components/AssistantMessage';
import { memoryWrittenCardContent } from '../../../src/runtime/useMemoryWrittenCard';
import { en } from '../../../src/i18n/locales/en';
import type { ChatMessage } from '../../../src/types';

afterEach(() => cleanup());

/** 卡的正文走**产线那支**生成器,不手搓 —— 形状变了这条要跟着红。 */
const MEMORY_CARD = memoryWrittenCardContent(
  {
    key: 'ext-opend-2745',
    count: 2,
    entries: [
      { id: 'rule_shared_product_card', name: '商品卡做成共享组件', type: 'rule' },
      { id: 'rule_radius_12px', name: '圆角统一 12px', type: 'rule' },
    ],
  },
  'Remembered 2 preferences',
);

const userAsks = (id: string, at: number): ChatMessage => ({
  id, role: 'user', content: '再做一版', createdAt: at,
} as ChatMessage);

/** 用户刚发出去、正在跑的那一轮 —— 真实运行,有 runId 有 runStatus。 */
const liveTurn = (): ChatMessage => ({
  id: 'assistant-live-run',
  role: 'assistant',
  content: '在做了',
  events: [{ kind: 'text', text: '在做了' }],
  agentId: 'claude',
  agentName: 'Claude',
  runId: 'run-live',
  runStatus: 'running',
  createdAt: 1_700_000_010_000,
  startedAt: 1_700_000_010_000,
} as ChatMessage);

/**
 * 宿主补发的记忆卡,**照 `ProjectView.tsx:5494` 的写法**:
 * 有 content、有一条 text 事件、有 agent 身份,
 * 但没有 runId / runStatus / startedAt / endedAt。
 */
const hostMemoryCard = (): ChatMessage => ({
  id: 'assistant-memory-card',
  role: 'assistant',
  content: MEMORY_CARD,
  events: [{ kind: 'text', text: MEMORY_CARD }],
  agentId: 'claude',
  agentName: 'Claude',
  createdAt: 1_700_000_011_000,
} as ChatMessage);

function renderChat(messages: ChatMessage[], streaming: boolean) {
  return render(
    <ChatPane
      messages={messages}
      streaming={streaming}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={() => {}}
      onStop={() => {}}
      conversations={[]}
      activeConversationId={null}
      onSelectConversation={() => {}}
      onDeleteConversation={() => {}}
    />,
  );
}

function messageRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-assistant-message-id="${id}"]`);
  if (!row) throw new Error(`夹具里没有这条助手消息:${id} —— 先修夹具,别改断言`);
  return row;
}

/** 这条消息在屏幕上有没有「进行中」的样子(执行记录壳那颗转球)。 */
function looksRunning(id: string): boolean {
  return messageRow(id).querySelector('[data-orb]') !== null;
}

describe('OPEND-2745 宿主补发的记忆卡不是一次运行', () => {
  /*
   * 真机那一刻的形状:上一轮的提取回报晚到,而用户已经发出了下一轮。
   * 记忆卡因此成了「最后一条助手消息」,面板正在流。
   */
  const sequence = () => [
    userAsks('u-1', 1_700_000_000_000),
    liveTurn(),
    hostMemoryCard(),
  ];

  it('只有一个「进行中」—— 记忆卡不跟着面板一起转', () => {
    renderChat(sequence(), true);

    // 正向锚点:真跑的那一轮**确实**在转。少了它,下面那条可以因为
    // 「整个执行记录壳压根没渲染」而假绿。
    expect(looksRunning('assistant-live-run'), '真实运行没有显示进行中 —— 夹具坏了').toBe(true);

    expect(
      document.querySelector('[data-assistant-message-id="assistant-memory-card"]'),
      '已退役的宿主记忆消息仍占据一行',
    ).toBeNull();
  });

  it('历史记忆卡不显示 UI，也不泄漏 od-card 原文', () => {
    const view = renderChat(sequence(), true);
    expect(messageRow('assistant-live-run')).toBeTruthy();
    expect(view.container.querySelector('[data-od-card="memory-applied"]')).toBeNull();
    expect(view.container.textContent).not.toContain('<od-card');
    expect(view.container.textContent).not.toContain('Remembered 2 preferences');
  });

  it('轮次跑完后记忆通知仍隐藏，真实运行完成状态保留', () => {
    renderChat([
      userAsks('u-1', 1_700_000_000_000),
      { ...liveTurn(), runStatus: 'succeeded', endedAt: 1_700_000_012_000 } as ChatMessage,
      hostMemoryCard(),
    ], false);

    expect(
      document.querySelector('[data-od-card="memory-applied"]'),
      'OPEND-2745 已退役记忆通知',
    ).toBeNull();
    expect(screen.queryByText('Remembered 2 preferences')).toBeNull();
    expect(screen.getByText(en['assistant.doneLabel'])).toBeTruthy();
  });
});

describe('OPEND-2745 没跑过的消息不报运行终态', () => {
  it('宿主补发的卡不挂「已完成」——它没有一轮可以完成', () => {
    render(
      <AssistantMessage
        message={hostMemoryCard()}
        streaming={false}
        projectId="project-1"
        conversationId="conv-1"
        isLast
      />,
    );
    // 纯宿主记忆消息整行隐藏；下一条测试单独证明真实运行仍显示完成。
    expect(document.querySelector('[data-assistant-message-id="assistant-memory-card"]')).toBeNull();
    expect(
      screen.queryByText(en['assistant.doneLabel']),
      '一条从来没有跑过的消息挂着「已完成」,读起来就是又一轮(OPEND-2745)',
    ).toBeNull();
  });

  it('真跑完的那一轮照旧挂「已完成」—— 修复不许顺手把它一起关掉', () => {
    render(
      <AssistantMessage
        message={{
          id: 'assistant-real-turn',
          role: 'assistant',
          content: '做完了',
          events: [{ kind: 'text', text: '做完了' }],
          runId: 'run-1',
          runStatus: 'succeeded',
          createdAt: 1_700_000_000_000,
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_003_000,
        } as ChatMessage}
        streaming={false}
        projectId="project-1"
        conversationId="conv-1"
        isLast
      />,
    );
    expect(screen.getByText(en['assistant.doneLabel'])).toBeTruthy();
  });
});

/**
 * ⚠️ **反向锚点 —— 少了这一节,修复可以退化成「没有 runStatus 就不算在跑」,
 * 而那会把 API / BYOK 模式的流式指示整个关掉,且只看正向用例的套件全绿。**
 *
 * `ProjectView.tsx:8142` 逐字:`runStatus: config.mode === 'daemon' ? 'running' : undefined`。
 * 也就是说 API 模式下**真运行**的乐观占位消息同样没有 runId、没有 runStatus,
 * 它靠的正是 `isAssistantMessageStreaming` 那条兜底。它和宿主补发的卡唯一的区别
 * 是 **`startedAt`**:真占位写了,补发的卡没有。
 */
describe('API 模式真运行的乐观占位仍然显示流式', () => {
  it('没有 runId / runStatus,但有 startedAt —— 它是一次真的运行', () => {
    renderChat([
      userAsks('u-1', 1_700_000_000_000),
      {
        id: 'assistant-api-placeholder',
        role: 'assistant',
        content: '',
        events: [],
        agentId: 'openai',
        agentName: 'GPT',
        createdAt: 1_700_000_010_000,
        startedAt: 1_700_000_010_000,
      } as ChatMessage,
    ], true);

    expect(
      looksRunning('assistant-api-placeholder'),
      'API 模式的真运行不显示流式了 —— 修复收得太紧',
    ).toBe(true);
  });
});
