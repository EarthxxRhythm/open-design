import { splitOnOdCards, type OdCardSegment } from '@open-design/contracts';
import { computeSkipRanges, rangeContains, type Range } from '../../artifacts/markdown-context';

function markdownCodeRanges(text: string): Range[] {
  const { ranges, unclosedFenceStart } = computeSkipRanges(text);
  return unclosedFenceStart === null
    ? ranges : [...ranges, [unclosedFenceStart, text.length]];
}

/**
 * Preserve Markdown code examples; decode real cards with the shared protocol parser.
 *
 * A closed `<od-card>…</od-card>` block whose payload does not parse is DROPPED —
 * never painted as prose. Product ruling (user, 2026-09-18): "od-card 如果 json
 * 不对, 就不显示, 不然用户会觉得是乱码...还不如不显示". A tail comma, a missing
 * `summary`, a misspelled `type` — the model writes all three — used to put the
 * whole `<od-card …>{…}</od-card>` block on screen as user-visible text, Markdown
 * and all (`user_profile` even came out italic). That reads as garbage, so the
 * card is simply absent instead.
 *
 * "Malformed" and "still streaming" are different states and only the first one
 * is dropped here. A card that has an opener but no `</od-card>` yet is a card
 * mid-flight: the `live` branches below withhold it (showing the prose written
 * before it) so a later delta can still complete it into a real card. Dropping a
 * block requires a matched close tag, i.e. a payload that is final and wrong.
 *
 * The decision stays in this render-layer helper rather than in the shared
 * `splitOnOdCards` parser: that parser is a lossless index-preserving split whose
 * other callers (`chat-protocol-context` Markdown skip-ranges, daemon
 * `memory-verify`) read spans of the ORIGINAL text, and it must keep returning
 * every character it was given.
 */
export function splitShellCards(text: string, live: boolean): OdCardSegment[] {
  let markdownStart = 0;
  let codeRanges = markdownCodeRanges(text);
  const result: OdCardSegment[] = [];
  const open = /<od-card(?=\s|>)[^>]*>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  function appendText(value: string): void {
    if (!value) return;
    const last = result.at(-1);
    if (last?.kind === 'text') last.text += value;
    else result.push({ kind: 'text', text: value });
  }

  while ((match = open.exec(text))) {
    if (rangeContains(codeRanges, match.index - markdownStart)) continue;
    const close = /<\/od-card>/gi;
    close.lastIndex = open.lastIndex;
    const end = close.exec(text);
    if (!end) {
      if (live) {
        appendText(text.slice(cursor, match.index));
        return result;
      }
      break;
    }
    appendText(text.slice(cursor, match.index));
    const raw = text.slice(match.index, close.lastIndex);
    // Only the opening marker is classified by Markdown context. A real card's
    // JSON can itself quote markup/backticks; its payload must remain opaque.
    const decoded = splitOnOdCards(raw);
    const parsed = decoded.some((segment) => segment.kind === 'card');
    // A closed block that did not parse is dropped, not appended: the user sees
    // nothing rather than raw protocol markup (see the ruling in the docblock).
    if (parsed) {
      for (const segment of decoded) {
        if (segment.kind === 'text') appendText(segment.text);
        else result.push(segment);
      }
    }
    cursor = close.lastIndex;
    open.lastIndex = cursor;
    if (parsed) {
      // Cards separate Markdown renders. Their JSON must not open a code span
      // in the following prose; a dropped block leaves the surrounding prose as
      // one Markdown render, so its context is deliberately left untouched.
      markdownStart = cursor;
      codeRanges = markdownCodeRanges(text.slice(markdownStart));
    }
  }
  if (live) {
    const candidateStart = text.lastIndexOf('<');
    if (candidateStart >= cursor && !rangeContains(codeRanges, candidateStart - markdownStart)) {
      const candidate = text.slice(candidateStart).toLowerCase();
      const opener = '<od-card';
      const partialName = candidate.startsWith('<od-') && opener.startsWith(candidate);
      const partialAttributes = candidate.startsWith(opener)
        && /^\s[^<>]*$/.test(candidate.slice(opener.length));
      if (partialName || partialAttributes) {
        // A future delta can complete this card opener. Keep earlier prose
        // visible now; terminal rendering restores candidates that never close.
        appendText(text.slice(cursor, candidateStart));
        return result;
      }
    }
  }
  appendText(text.slice(cursor));
  return result;
}
