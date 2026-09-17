// @vitest-environment jsdom
/**
 * OPEND-2745 —「记忆相关消息露出原始 XML / 标签文本」的**推理流那一条残余路径**。
 *
 * ── 工单原话 ──────────────────────────────────────────────────────
 * 预期结果:「任何阶段都不应向用户暴露原始 `od-card` 标签或 JSON。」
 * 修复建议 ④:「确保 `memory-applied` 在 streaming 与持久化回放两条路径都统一
 *              经过 `splitOnOdCards()`。」
 *
 * ── 已经修掉的那一半 ──────────────────────────────────────────────
 * QA 在 Beta `0.21.1-beta.7` 的附件里拍到的是**合法**的
 * `<od-card type="memory-applied">` 摊在执行记录壳的叙述位上。那一条已由 #7956
 * 关掉:`SayBlock` 改走 `splitShellCards`,壳内叙述和壳外正文用同一支解析器。
 * 本文件**不**重复那个用例 —— `od-card-inside-execution-shell.test.tsx` 已经钉住了。
 *
 * ── 本文件钉住的缺口 ──────────────────────────────────────────────
 * **thinking(推理)流**。`ExecutionShell` 把 `kind:'thinking'` 的文本交给
 * `ThinkingMarkdown` → `renderMarkdown`,**整条链上没有 `splitShellCards`**。
 * 系统提示词(`apps/daemon/src/prompts/system.ts:1220`)是让模型「emit one compact
 * chip」的,并没有规定它只能出现在正文而不能出现在推理里;模型一旦把这枚 chip
 * 写进推理,标签原文就原样摊给用户 —— 和 beta.7 那张截图是同一个观感。
 *
 * ⚠️ 判据只写「用户看不到 `<od-card` 原文」,**不规定**怎么做到 —— 这是行为级的,
 * 不断言某个函数被调用过。
 *
 * ── 不在本文件范围内 ──────────────────────────────────────────────
 * `splitOnOdCards` 对**解析失败**的卡保留原文(源码注释:`Malformed — keep raw
 * text so the user can still see it`)是刻意约定,改不改是产品裁决点,**另有裁决**,
 * 本文件不碰。
 *
 * ── 反向锚点(少了它修复会退化成「见 od-card 就吞」)────────────────
 * ① 围栏代码块里引用的 od-card **必须**留着原文:那是文档/教程在讲协议本身。
 * ② 壳外正文里的合法卡照旧走 `OdCardView`(OPEND-2607 防回归)。
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AssistantMessage } from '../../../src/components/AssistantMessage';
import { ThinkingMarkdown } from '../../../src/components/chat/ThinkingMarkdown';
import { memoryWrittenCardContent } from '../../../src/runtime/useMemoryWrittenCard';
import type { ChatMessage } from '../../../src/types';

afterEach(() => cleanup());

/** 合法记忆卡 —— 走**产线那支**生成器,形状变了这条要跟着红。 */
const VALID_CARD = memoryWrittenCardContent(
  { key: 'ext-2745', count: 1, entries: [{ id: 'user_profile', name: 'Work profile', type: 'profile' }] },
  '已记住 1 条偏好',
);

function renderAssistantProse(content: string): string {
  render(
    <AssistantMessage
      message={{
        id: 'assistant-turn',
        role: 'assistant',
        content,
        events: [{ kind: 'text', text: content }],
        runId: 'run-1',
        runStatus: 'succeeded',
        createdAt: 1_700_000_000_000,
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_003_000,
      } as ChatMessage}
      streaming={false}
      projectId="project-1"
      conversationId="conversation-1"
      isLast
    />,
  );
  return document.body.textContent ?? '';
}

describe('OPEND-2745 ① 推理流里的记忆卡不得摊出标签原文', () => {
  it('合法的 memory-applied 写进 thinking —— 用户看到的是卡或一句话,不是标签', () => {
    render(<ThinkingMarkdown texts={[`先看一下用户的偏好。\n\n${VALID_CARD}`]} live={false} />);
    const text = document.body.textContent ?? '';

    // 正向锚点:推理正文**还在**。少了它,下面那条可以因为「整块没渲染」而假绿。
    expect(text, '推理正文整块没渲染 —— 夹具坏了,别改断言').toContain('先看一下用户的偏好');

    expect(text, '推理流把 od-card 标签原文摊给用户看了(OPEND-2745 预期④)')
      .not.toContain('<od-card');
  });
});

/**
 * 推理流是**流式**的:一枚 chip 是一个 delta 一个 delta 长出来的。两个都不许发生 ——
 * 半截标签闪出原文,或者「卡还没闭合」把它**前面**已经写完的推理正文一起吞掉。
 */
describe('OPEND-2745 ① 流式:半截卡既不闪原文也不吞正文', () => {
  const PROSE = '先看一下用户的偏好。';

  it('标签名只写了一半', () => {
    render(<ThinkingMarkdown texts={[`${PROSE}\n\n<od-ca`]} live />);
    const text = document.body.textContent ?? '';
    expect(text, '半截标签把它前面的推理正文一起吞了').toContain(PROSE);
    expect(text, '半截标签直接闪给用户看了').not.toContain('<od-ca');
  });

  it('开标签写完了、JSON 还在写', () => {
    render(
      <ThinkingMarkdown
        texts={[`${PROSE}\n\n<od-card type="memory-applied">{"summary":"已记住 1 条`]}
        live
      />,
    );
    const text = document.body.textContent ?? '';
    expect(text, '卡还没闭合就把它前面的推理正文一起吞了').toContain(PROSE);
    expect(text, '没闭合的卡把标签原文闪给用户看了').not.toContain('<od-card');
  });

  it('卡闭合的那一帧渲染成卡,正文照旧在', () => {
    render(<ThinkingMarkdown texts={[`${PROSE}\n\n${VALID_CARD}`]} live />);
    const text = document.body.textContent ?? '';
    expect(text).toContain(PROSE);
    expect(text).not.toContain('<od-card');
    expect(
      document.querySelector('[data-od-card="memory-applied"]'),
      '推理流里的卡被当噪音删掉了 —— 解析口径要和正文一致,不是「见 od-card 就吞」',
    ).not.toBeNull();
  });
});

/**
 * ⚠️ **反向锚点** —— 少了这一节,修复可以退化成「扫到 `<od-card` 就抹掉」,
 * 而那会把**讲协议的文档正文**一起吞掉,且只看正向用例的套件全绿。
 */
describe('OPEND-2745 代码块里引用的 od-card 仍然是正文', () => {
  it('围栏代码块里的卡原样保留', () => {
    const text = renderAssistantProse(
      ['协议长这样:', '', '```html', VALID_CARD, '```'].join('\n'),
    );
    expect(text, '代码块里引用的协议示例被吞了 —— 修复收得太狠')
      .toContain('<od-card type="memory-applied"');
  });

  it('推理流里围栏代码块中的卡同样原样保留', () => {
    render(
      <ThinkingMarkdown
        texts={[['协议长这样:', '', '```html', VALID_CARD, '```'].join('\n')]}
        live={false}
      />,
    );
    expect(
      document.body.textContent ?? '',
      '推理里引用的协议示例被吞了 —— 推理流的解析口径也收得太狠',
    ).toContain('<od-card type="memory-applied"');
  });
});

describe('OPEND-2745 合法记忆卡照旧渲染成卡(OPEND-2607 反向锚点)', () => {
  it('壳外正文里的合法卡走 OdCardView', () => {
    const text = renderAssistantProse(VALID_CARD);
    expect(document.querySelector('[data-od-card="memory-applied"]')).not.toBeNull();
    expect(text).toContain('已记住 1 条偏好');
    expect(text).not.toContain('<od-card');
  });
});
