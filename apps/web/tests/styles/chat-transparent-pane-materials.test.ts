// Measurement spec for the chat containers that sit on the TRANSPARENT chat
// pane (OPEND-3177 / OPEND-3175 / OPEND-3173, OPEND-2553 K1; supersedes the
// H1 pins from #8166). After S6 made the pane paint nothing (OPEND-3090), the
// containers that used to borrow the pane's white showed up as flat slabs over
// the app wash. H1 answered with the frosted Regular material; the direction
// settled on since (#8165 commit 1) is the opposite: ONE opaque floating card
// for everything in the content layer, and one plain elevated menu for the
// popovers. So:
//
//   content layer — composer shell, question form (shell / body / foot),
//     Confirmed answer block, thoughts window, nested terminal block — read
//     the same floating-card tokens the queued-send cards already use
//     (`--chat-floating-card-bg` + `--chat-border-soft`), with NO backdrop
//     blur and no shadow;
//   popovers — project switcher menu, conversation history menu — use the
//     action-menu recipe (`--bg` ground, `--border-soft` edge, `--shadow-md`).
//
// Values here are token names, not colours: dark and reduced-transparency
// follow the token layer, so the components carry no per-appearance override.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const composioCss = read('../../src/styles/viewer/composio.css');
const routinesCss = read('../../src/styles/viewer/routines.css');
const chatCss = read('../../src/styles/chat.css');
const recordCss = read('../../src/components/chat/primitives/record.module.css');
const chatRootCss = read('../../src/components/chat/ChatRoot.module.css');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function declarations(css: string, selector: string): string {
  const cssWithoutComments = stripComments(css);
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

/** Whether any rule in `css` (including inside at-rules) targets `selector`. */
function declares(css: string, selector: string): boolean {
  try {
    declarations(css, selector);
    return true;
  } catch {
    return false;
  }
}

/** The last value declared for `property` in a block ('' when absent). */
function value(block: string, property: string): string {
  const pattern = new RegExp(`(?:^|;)\\s*${property.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`, 'g');
  const values = [...block.matchAll(pattern)].map((m) => m[1]!.trim());
  return values.at(-1) ?? '';
}

/** The last `background` / `background-color` value declared in a block. */
function background(block: string): string {
  const values = [...block.matchAll(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/g)].map((m) => m[1]!.trim());
  return values.at(-1) ?? '';
}

/** H1's frosted / glass tokens: none of these containers may read them now. */
const FROSTED = /--(?:chat-)?material-|--glass-|--vibrancy-fill/;

/** An opaque card in the content layer: the floating-card tokens, no blur. */
function expectFloatingCard(block: string) {
  expect(background(block)).toBe('var(--chat-floating-card-bg)');
  expect(block).not.toMatch(/backdrop-filter\s*:\s*var\(/);
  expect(block).not.toMatch(FROSTED);
}

/** A popover in the action-menu recipe: plain ground, soft edge, md shadow. */
function expectActionMenu(block: string) {
  expect(background(block)).toBe('var(--bg)');
  expect(value(block, 'border')).toBe('1px solid var(--border-soft)');
  expect(value(block, 'box-shadow')).toBe('var(--shadow-md)');
  expect(block).not.toMatch(/backdrop-filter\s*:\s*var\(/);
  expect(block).not.toMatch(FROSTED);
}

describe('composer shell is one opaque floating card (styles/viewer/routines.css)', () => {
  const shell = declarations(routinesCss, '.chat-composer-fixed-layer .composer-shell');

  it('reads the floating-card ground and soft edge at the xl radius, with no shadow', () => {
    expectFloatingCard(shell);
    expect(value(shell, 'border-color')).toBe('var(--chat-border-soft)');
    expect(value(shell, 'border-radius')).toBe('var(--chat-radius-xl)');
    expect(value(shell, 'box-shadow')).toBe('none');
  });

  it('switches the backdrop blur off explicitly (chat.css used to give it glass)', () => {
    expect(value(shell, '-webkit-backdrop-filter')).toBe('none');
    expect(value(shell, 'backdrop-filter')).toBe('none');
    expect(declares(chatCss, '.chat-composer-fixed-layer .composer-shell')).toBe(false);
  });

  it('keeps the compact inset of the reference (5px padding, 8px gap)', () => {
    expect(value(shell, 'padding')).toBe('5px');
    expect(value(shell, 'gap')).toBe('8px');
  });

  it('carries no per-appearance override: dark follows the floating-card token', () => {
    expect(declares(routinesCss, '[data-theme="dark"] .chat-composer-fixed-layer .composer-shell')).toBe(false);
    expect(declares(routinesCss, 'html:not([data-theme]) .chat-composer-fixed-layer .composer-shell')).toBe(false);
  });

  it('has the xl radius alias on the chat seam in both appearances', () => {
    for (const scope of [declarations(chatRootCss, '.root'), declarations(chatRootCss, ":global([data-theme='dark']) .root")]) {
      expect(scope).toMatch(/--chat-radius-xl:\s*var\(--radius-xl\);/);
    }
  });
});

describe('question form on the transparent pane (styles/viewer/composio.css)', () => {
  it('gives the card shell the floating-card ground and soft edge instead of the frosted material', () => {
    const shell = declarations(composioCss, '.question-form');
    expectFloatingCard(shell);
    expect(value(shell, 'border')).toBe('1px solid var(--chat-border-soft)');
  });

  it('keeps the confirm variant on the same floating card', () => {
    expectFloatingCard(declarations(composioCss, '.question-form:has(.question-form-foot):has(.qf-options)'));
  });

  it('lets the head, body and pill paint nothing of their own so the shell is the only surface', () => {
    expect(background(declarations(composioCss, '.question-form-head'))).toBe('transparent');
    expect(background(declarations(composioCss, '.question-form-body'))).toBe('transparent');
    expect(background(declarations(composioCss, '.question-form-pill'))).toBe('transparent');
    expect(background(declarations(composioCss, '.question-form-foot'))).toBe('');
  });

  it('puts the Confirmed answer block on the floating card', () => {
    expectFloatingCard(declarations(composioCss, '.answered'));
  });
});

describe('thoughts window and nested terminal block (chat/primitives/record.module.css)', () => {
  it('gives the thoughts window the floating-card ground instead of the frosted material', () => {
    expectFloatingCard(declarations(recordCss, '.thoughts > .body.stack'));
  });

  it('gives the nested command + output block the floating-card ground and soft edge', () => {
    const code = declarations(recordCss, '.fold .body.stack .code');
    expectFloatingCard(code);
    expect(value(code, 'border')).toBe('var(--chat-stroke) solid var(--chat-border-soft)');
  });

  it('no longer needs the H1 material seam tokens on the chat root', () => {
    expect(chatRootCss).not.toMatch(/--chat-material-/);
    expect(recordCss).not.toMatch(FROSTED);
  });
});

describe('popovers over the pane use the action-menu recipe (routines.css + composio.css)', () => {
  it('draws the project switcher menu as a plain elevated menu, rows on the subtle fill', () => {
    expectActionMenu(declarations(routinesCss, '.workspace-tabs-dropdown__menu'));
    expect(background(declarations(routinesCss, '.workspace-tabs-dropdown__row:hover'))).toBe('var(--bg-subtle)');
  });

  it('draws the conversation history menu the same way, with its search field back on a solid mix', () => {
    expectActionMenu(declarations(composioCss, '.chat-history-menu'));
    const search = declarations(composioCss, '.chat-history-search');
    expect(background(search)).toBe('color-mix(in srgb, var(--bg) 88%, var(--bg-panel))');
    expect(value(search, 'border')).toBe('1px solid color-mix(in srgb, var(--border) 78%, transparent)');
    expect(background(declarations(composioCss, '.chat-history-search:hover'))).toBe('color-mix(in srgb, var(--bg) 94%, var(--bg-panel))');
    expect(search).not.toMatch(FROSTED);
  });
});
