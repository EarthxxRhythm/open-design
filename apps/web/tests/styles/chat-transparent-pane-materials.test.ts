// Measurement spec for the chat containers that sit on the TRANSPARENT chat
// pane (OPEND-3177 / OPEND-3175 / OPEND-3178, OPEND-2553 H1). After S6 made
// the pane paint nothing (OPEND-3090), every container that used to borrow the
// pane's white — the question form, the Confirmed answer block, the thoughts
// window, the nested terminal block, the composer shell, the project dropdown
// and the conversation history menu — showed up as a flat opaque slab over the
// app wash. Each one now reads a material from `styles/material.css`
// (content-layer cards: Regular material; floating menus: liquid glass) so the
// wash / window vibrancy shows through, and the tokens flatten back to a solid
// surface when transparency is reduced or backdrop-filter is unsupported.
// Values here are token names, not colours: the tint level is a design call
// and changes here, not in the components.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const composioCss = read('../../src/styles/viewer/composio.css');
const routinesCss = read('../../src/styles/viewer/routines.css');
const materialCss = read('../../src/styles/material.css');
const recordCss = read('../../src/components/chat/primitives/record.module.css');
const chatRootCss = read('../../src/components/chat/ChatRoot.module.css');

function declarations(css: string, selector: string): string {
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
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

/** The declarations of `selector` inside the at-rule blocks whose prelude
 *  contains `atRule` (a file may carry several such blocks). */
function declarationsInside(css: string, atRule: string, selector: string): string {
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodies: string[] = [];
  let start = cssWithoutComments.indexOf(atRule);
  if (start === -1) throw new Error(`Missing at-rule ${atRule}`);
  while (start !== -1) {
    const open = cssWithoutComments.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let index = open; index < cssWithoutComments.length; index += 1) {
      const char = cssWithoutComments[index];
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    bodies.push(cssWithoutComments.slice(open + 1, end));
    start = cssWithoutComments.indexOf(atRule, end);
  }
  const matches = bodies.flatMap((body) => {
    try {
      return [declarations(body, selector)];
    } catch {
      return [];
    }
  });
  if (matches.length === 0) throw new Error(`Missing CSS block for ${selector} inside ${atRule}`);
  return matches.join('\n');
}

/** The last `background` / `background-color` value declared in a block. */
function background(block: string): string {
  const values = [...block.matchAll(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/g)].map((m) => m[1]!.trim());
  return values.at(-1) ?? '';
}

/** Solid paints that the transparent pane no longer hides: pure white and the
 *  opaque panel / page tokens that resolve to #fff / #fafafa. */
const OPAQUE = /(^|[^-\w])(#fff\b|#ffffff\b|white\b|var\(--bg\)|var\(--bg-panel\)|var\(--chat-bg\)|var\(--chat-bg-panel\)|var\(--chat-confirm-surface[^)]*\))/;

function expectMaterial(block: string, tint: string, backdrop: string) {
  expect(background(block)).toBe(`var(${tint})`);
  expect(block).toMatch(new RegExp(`-webkit-backdrop-filter:\\s*var\\(${backdrop}\\);`));
  expect(block).toMatch(new RegExp(`(^|[^-])backdrop-filter:\\s*var\\(${backdrop}\\);`));
  expect(background(block)).not.toMatch(OPAQUE);
}

describe('question form on the transparent pane (styles/viewer/composio.css)', () => {
  it('gives the card shell the Regular material with the material separator instead of the opaque panel', () => {
    const shell = declarations(composioCss, '.question-form');
    expectMaterial(shell, '--material-regular', '--material-regular-backdrop');
    expect(shell).toMatch(/border:\s*1px solid var\(--material-separator\);/);
  });

  it('keeps the confirm variant on the same material rather than the opaque confirm surface', () => {
    const confirm = declarations(composioCss, '.question-form:has(.question-form-foot):has(.qf-options)');
    expect(background(confirm)).toBe('var(--material-regular)');
    expect(background(confirm)).not.toMatch(OPAQUE);
  });

  it('lets the head, body and pill paint nothing of their own so the shell material is the only surface', () => {
    expect(background(declarations(composioCss, '.question-form-head'))).toBe('transparent');
    expect(background(declarations(composioCss, '.question-form-body'))).toBe('transparent');
    expect(background(declarations(composioCss, '.question-form-pill'))).toBe('transparent');
  });

  it('puts the Confirmed answer block on the Regular material', () => {
    expectMaterial(declarations(composioCss, '.answered'), '--material-regular', '--material-regular-backdrop');
  });
});

describe('thoughts window and nested terminal block (chat/primitives/record.module.css)', () => {
  it('routes the materials through the --chat-* seam in both appearances', () => {
    for (const scope of [declarations(chatRootCss, '.root'), declarations(chatRootCss, ":global([data-theme='dark']) .root")]) {
      expect(scope).toMatch(/--chat-material-regular:\s*var\(--material-regular\);/);
      expect(scope).toMatch(/--chat-material-regular-backdrop:\s*var\(--material-regular-backdrop\);/);
      expect(scope).toMatch(/--chat-material-separator:\s*var\(--material-separator\);/);
    }
  });

  it('gives the thoughts window the Regular material instead of the opaque panel', () => {
    expectMaterial(declarations(recordCss, '.thoughts > .body.stack'), '--chat-material-regular', '--chat-material-regular-backdrop');
  });

  it('gives the nested command + output block the Regular material and the material separator', () => {
    const code = declarations(recordCss, '.fold .body.stack .code');
    expectMaterial(code, '--chat-material-regular', '--chat-material-regular-backdrop');
    expect(code).toMatch(/border:\s*var\(--chat-stroke\) solid var\(--chat-material-separator\);/);
  });
});

describe('floating menus over the pane (styles/viewer/routines.css + composio.css)', () => {
  it('lifts the project dropdown onto liquid glass instead of pure white', () => {
    const menu = declarations(routinesCss, '.workspace-tabs-dropdown__menu');
    expectMaterial(menu, '--glass-regular', '--glass-backdrop');
    expect(menu).toMatch(/border:\s*1px solid var\(--material-separator\);/);
    expect(background(declarations(routinesCss, '.workspace-tabs-dropdown__row:hover'))).toBe('var(--vibrancy-fill-tertiary)');
  });

  it('lifts the conversation history menu onto liquid glass instead of the opaque panel', () => {
    const menu = declarations(composioCss, '.chat-history-menu');
    expectMaterial(menu, '--glass-regular', '--glass-backdrop');
    expect(menu).toMatch(/border:\s*1px solid var\(--material-separator\);/);
    const search = declarations(composioCss, '.chat-history-search');
    expect(background(search)).toBe('var(--vibrancy-fill-tertiary)');
    expect(search).toMatch(/border:\s*1px solid var\(--material-separator\);/);
  });
});

describe('composer shell on the transparent pane (styles/viewer/routines.css)', () => {
  it('replaces the opaque grey mix with the Regular material in both appearances', () => {
    expectMaterial(
      declarations(routinesCss, '.chat-composer-fixed-layer .composer-shell'),
      '--material-regular',
      '--material-regular-backdrop',
    );
    expect(background(declarations(routinesCss, '[data-theme="dark"] .chat-composer-fixed-layer .composer-shell'))).toBe('var(--material-regular)');
    expect(
      background(declarationsInside(routinesCss, '@media (prefers-color-scheme: dark)', 'html:not([data-theme]) .chat-composer-fixed-layer .composer-shell')),
    ).toBe('var(--material-regular)');
  });
});

describe('degraded environments keep a solid surface (styles/material.css)', () => {
  it('flattens every material and glass token to the elevated surface under reduced transparency and without backdrop-filter', () => {
    for (const atRule of ['@media (prefers-reduced-transparency: reduce)', '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))']) {
      const root = declarationsInside(materialCss, atRule, 'html:root');
      expect(root).toMatch(/--material-regular:\s*var\(--bg-elevated\);/);
      expect(root).toMatch(/--glass-regular:\s*var\(--bg-elevated\);/);
      expect(root).toMatch(/--material-separator:\s*var\(--border\);/);
    }
    expect(declarationsInside(materialCss, '@media (prefers-reduced-transparency: reduce)', 'html:root')).toMatch(/--material-regular-backdrop:\s*none;/);
  });
});
