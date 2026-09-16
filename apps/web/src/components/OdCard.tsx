// Retired ChatPanel cards remain decodable for historical transcripts,
// but their payloads have no ChatPanel presentation (OPEND-2745).
import type {
  OdCard,
  OdCardBrandBrowserAssist,
} from '@open-design/contracts';

/** Compatibility result for existing browser-assist callers outside this renderer. */
export interface BrandBrowserAssistResult {
  ok: boolean;
  /** `opened` means the Browser tab was focused/navigated; extraction still
   * continues from the next-step action after the user clears verification. */
  action?: 'opened' | 'confirmed';
  /** Failure reason to show inline (e.g. "needs the desktop app"). */
  message?: string;
}

export type BrandBrowserAssistConfirm = (
  card: OdCardBrandBrowserAssist,
) => Promise<BrandBrowserAssistResult | void> | BrandBrowserAssistResult | void;

export function OdCardView({
  card,
}: {
  card: OdCard;
  /** Compatibility with existing message/shell callers; retired cards used this scope. */
  instanceScope?: string;
  onBrandBrowserAssistConfirm?: BrandBrowserAssistConfirm;
}) {
  switch (card.kind) {
    case 'task-brief':
    case 'rule-proposal':
    case 'brand-browser-assist':
    case 'verify-scorecard':
    case 'memory-applied':
      return null;
    default:
      return null;
  }
}
