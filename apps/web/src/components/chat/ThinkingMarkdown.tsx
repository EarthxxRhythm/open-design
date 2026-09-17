import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderMarkdown } from '../../runtime/markdown';
import { splitShellCards } from '../../runtime/chat/split-shell-cards';
import { OdCardView } from '../OdCard';
import { useCharReveal } from './useCharReveal';
import styles from './ThinkingMarkdown.module.css';

/**
 * A live model can produce dozens of thinking deltas per second. Parsing the
 * entire accumulated Markdown for every delta makes a long stream quadratic
 * and replaces a large React subtree more often than a display can paint.
 * Ten commits per second is still visibly live while placing a hard ceiling on
 * full-document Markdown parses and DOM commits.
 */
export const THINKING_MARKDOWN_COMMIT_MS = 100;

export interface ThinkingMarkdownProps {
  texts: readonly string[];
  live: boolean;
}

export function ThinkingMarkdown({ texts, live }: ThinkingMarkdownProps): ReactElement | null {
  const source = texts.join('\n\n').trim();
  const snapshot = useCoalescedSnapshot(source, live);
  if (!snapshot) return null;
  return <RenderedThinkingMarkdown text={snapshot} live={live} />;
}

/**
 * Keep the scheduler separate from the parsed subtree. The outer component is
 * intentionally cheap and may receive every delta; this memoized child only
 * renders when the coalesced string changes, so neither Markdown parsing nor
 * `useCharReveal` walks the DOM for discarded intermediate deltas.
 */
const RenderedThinkingMarkdown = memo(function RenderedThinkingMarkdown({
  text,
  live,
}: {
  text: string;
  live: boolean;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  useCharReveal(rootRef, live);
  const content = useMemo(() => decodedProse(text, live), [live, text]);

  return (
    <div ref={rootRef} className={styles.think} data-testid="thinking-markdown">
      {content}
    </div>
  );
});

/**
 * 推理正文 —— 先过**那一支** od-card 解析器,再当 Markdown 画。
 *
 * ## 不变量
 *
 * **一段模型文本里哪几个字节是协议卡、哪几个是用户该读的正文,全仓只有
 * `splitShellCards` 一处答案。** 壳内叙述(`SayBlock`)、壳外正文
 * (`AssistantMessage`)、推理流(这里)三条通道共用它;谁绕过去自己写一套
 * 字符串处理,谁就把 `<od-card …>{…}</od-card>` 的标签原文摊给用户看
 * (OPEND-2607 / OPEND-2745)。
 *
 * 推理流原来就是那个绕过去的第三条:它直接 `renderMarkdown(text)`。而系统提示词
 * 只说「applied memory 时可以发一枚 compact chip」,**没有**规定这枚 chip 不许
 * 落在推理里(`apps/daemon/src/prompts/system.ts`)—— 所以推理流必须和正文一样
 * 具备解码能力,而不是假定卡片只走正文。
 *
 * ## 两条边界
 *
 * · **没有卡时整篇一次解析**。跨卡片的 Markdown 结构(列表、围栏)不能被无谓切开,
 *   而绝大多数推理里一张卡都没有 —— 那一档必须和改动前逐字一致。
 * · **流式由同一支解析器判**(`live`):半截标签留给下一帧、不闪原文;还没闭合的卡
 *   不吞掉它**前面**已经写完的推理正文。这里不许再加第二套流式判断。
 *
 * 围栏代码块里引用的卡是**用户正文**(文档在讲协议本身),`splitShellCards` 已经
 * 按 Markdown 上下文放行,这里不要再动。
 */
function decodedProse(text: string, live: boolean): ReactNode {
  const segments = splitShellCards(text, live);
  if (!segments.some((seg) => seg.kind === 'card')) {
    return renderMarkdown(
      segments.map((seg) => (seg.kind === 'text' ? seg.text : '')).join(''),
      { syntaxHighlight: !live },
    );
  }
  return segments.map((seg, i) => {
    if (seg.kind === 'card') return <OdCardView key={`card-${i}`} card={seg.card} />;
    if (!seg.text.trim()) return null;
    return (
      <Fragment key={`text-${i}`}>
        {renderMarkdown(seg.text, { syntaxHighlight: !live })}
      </Fragment>
    );
  });
}

function useCoalescedSnapshot(source: string, live: boolean): string {
  const [snapshot, setSnapshot] = useState(source);
  const latestRef = useRef(source);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  latestRef.current = source;

  useEffect(() => {
    if (!live) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Keep state aligned with the immediately rendered final source. This
      // matters if the same component instance becomes live again (preview
      // replay / status correction): it must resume from the final text, not
      // from the last throttled snapshot that preceded completion.
      if (snapshot !== source) setSnapshot(source);
      return;
    }
    if (snapshot === source || timerRef.current !== null) return;

    // This is a fixed-window throttle, not a debounce: a continuous ds-v4-flash
    // stream still becomes visible every 100ms instead of being starved until
    // the model stops.
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setSnapshot(latestRef.current);
    }, THINKING_MARKDOWN_COMMIT_MS);
  }, [live, snapshot, source]);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  // The completion frame must never wait behind the throttle. It also enables
  // syntax highlighting, which is deliberately skipped while the fence grows.
  return live ? snapshot : source;
}
