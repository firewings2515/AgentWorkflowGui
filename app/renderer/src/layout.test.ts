// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import css from './styles.css?raw';
// T051: the v0.4 shell's own stylesheet carries the conversation layout now.
import v4css from './shell-v4/styles.css?raw';

// Inspect declarations, not geometry: jsdom does not perform browser layout.
function parseRules(source: string) {
  const element = document.createElement('style');
  element.textContent = source;
  document.head.append(element);
  try {
    if (!element.sheet) throw new Error('Could not parse layout stylesheet');
    return Array.from(element.sheet.cssRules);
  } finally {
    element.remove();
  }
}

function baseValue(rules: CSSRule[], selector: string, property: string) {
  return rules
    .filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE)
    .filter(rule => rule.selectorText.split(',').some(part => part.trim() === selector))
    .map(rule => declarationValue(rule, property))
    .filter(Boolean)
    .at(-1);
}

function declarationValue(rule: CSSStyleRule, property: string) {
  const value = rule.style.getPropertyValue(property).trim();
  // CSSOM serializes a unitless zero length as 0px.
  return property === 'min-height' && value === '0px' ? '0' : value;
}

function mediaViolations(rules: CSSRule[], inMedia = false): string[] {
  return rules.flatMap(rule => {
    if (rule.type !== CSSRule.STYLE_RULE && 'cssRules' in rule) {
      return mediaViolations(
        Array.from((rule as CSSGroupingRule).cssRules),
        inMedia || rule.type === CSSRule.MEDIA_RULE,
      );
    }
    if (!inMedia || rule.type !== CSSRule.STYLE_RULE) return [];
    const styleRule = rule as CSSStyleRule;
    // Include qualified/combined selectors (old and v0.4 transcripts), but not .transcript-heading or .v4-transcript-frame.
    if (!/\.(v4-)?transcript(?![\w-])/.test(styleRule.selectorText)) return [];
    return ([
      ['min-height', '0'],
      ['overflow', 'auto'],
      ['overflow-x', 'auto'],
      ['overflow-y', 'auto'],
    ] as const).flatMap(([property, expected]) => {
      const value = declarationValue(styleRule, property);
      return value && value !== expected
        ? [`${styleRule.selectorText}: ${property}: ${value}`]
        : [];
    });
  });
}

// Separate @media blocks with the same condition still share one cascade scope.
function mediaConflicts(rules: CSSRule[]) {
  const declarations = new Map<string, string>();
  const conflicts: string[] = [];
  function visit(current: CSSRule[], conditions: string[]) {
    for (const rule of current) {
      if (rule.type === CSSRule.MEDIA_RULE) {
        const media = rule as CSSMediaRule;
        visit(Array.from(media.cssRules), [...conditions, media.conditionText]);
      } else if (rule.type === CSSRule.STYLE_RULE && conditions.length) {
        const style = rule as CSSStyleRule;
        for (const selector of style.selectorText.split(',').map(part => part.trim())) {
          for (let index = 0; index < style.style.length; index++) {
            const property = style.style[index]!;
            const key = `${conditions.join(' / ')} | ${selector} | ${property}`;
            const value = style.style.getPropertyValue(property).trim();
            const previous = declarations.get(key);
            if (previous !== undefined && previous !== value) conflicts.push(`${key}: ${previous} -> ${value}`);
            declarations.set(key, value);
          }
        }
      }
    }
  }
  visit(rules, []);
  return conflicts;
}

describe('layout stylesheet declarations', () => {
  const rules = parseRules(css);
  const v4 = parseRules(v4css);

  it('keeps dependency labels readable and reserves space for three rows', () => {
    expect(baseValue(rules, '.dependency-canvas', 'height')).toBe('360px');
    expect(baseValue(rules, '.dependency-canvas .task-dependency-node', 'width')).toBe('220px');
    expect(baseValue(rules, '.dependency-canvas .task-dependency-node', 'min-height')).toBe('64px');
    expect(baseValue(rules, '.dependency-canvas .task-dependency-node', 'font-size')).toBe('16px');
    expect(baseValue(rules, '.dependency-canvas .task-dependency-node', 'overflow-wrap')).toBe('anywhere');
  });

  // T051: the height chain of the v0.4 shell; every box down to the transcript must be able to shrink.
  it.each([
    ['.v4-shell', 'height', '100dvh'],
    ['.v4-shell', 'overflow', 'hidden'],
    ['.v4-main', 'min-height', '0'],
    ['.v4-panes', 'min-height', '0'],
    ['.v4-panes', 'grid-template-columns', 'minmax(0, 1fr)'],
    ['.v4-pane', 'min-height', '0'],
    ['.v4-pane-main', 'min-height', '0'],
    ['.v4-transcript-frame', 'min-height', '0'],
    ['.v4-transcript-frame', 'position', 'relative'],
    ['.v4-transcript', 'min-height', '0'],
    ['.v4-transcript', 'overflow', 'auto'],
    ['.v4-transcript', 'overflow-anchor', 'none'],
    ['.v4-composer-dock', 'flex-shrink', '0'],
    ['.v4-details', 'min-height', '0'],
    ['.v4-sections', 'min-height', '0'],
    ['.v4-sections', 'overflow', 'auto'],
  ])('v0.4 %s retains %s: %s in base rules', (selector, property, expected) => {
    expect(baseValue(v4, selector, property)).toBe(expected);
  });

  it('the v0.4 transcript keeps shrinking and scrolling in every media query, without conflicts', () => {
    expect(mediaViolations(v4)).toEqual([]);
    expect(mediaConflicts(v4)).toEqual([]);
  });

  it('compacts the v0.4 composer for 768px height (T034) and stacks a split below 900px', () => {
    const media = v4.filter((rule): rule is CSSMediaRule => rule.type === CSSRule.MEDIA_RULE);
    const compact = media.find(rule => rule.conditionText === '(max-height: 800px)')!;
    expect(baseValue(Array.from(compact.cssRules), '.v4-composer textarea', 'min-height')).toBe('40px');
    const narrow = media.find(rule => rule.conditionText === '(max-width: 900px)')!;
    expect(baseValue(Array.from(narrow.cssRules), '.v4-split', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(baseValue(Array.from(narrow.cssRules), '.v4-split .v4-pane:not(.v4-pane-active)', 'display')).toBe('none');
  });

  it.each([
    ['.agent-form-actions', 'position', 'sticky'],
    ['.agent-form-actions', 'bottom', '0px'],
    ['.agent-form-actions', 'background', 'var(--panel)'],
    ['.agent-editor', 'overflow', 'auto'],
    ['.agent-editor', 'scroll-padding-bottom', '100px'],
  ])('%s retains %s: %s in base rules', (selector, property, expected) => {
    expect(baseValue(rules, selector, property)).toBe(expected);
  });

  it('preserves transcript shrinking and scrolling in every media query', () => {
    expect(mediaViolations(rules)).toEqual([]);
  });

  it('stacks progress logs at 1024px width', () => {
    const media = rules.filter((rule): rule is CSSMediaRule => rule.type === CSSRule.MEDIA_RULE);
    const progress = media.find(rule => rule.conditionText === '(max-width: 1100px)')!;
    expect(baseValue(Array.from(progress.cssRules), '.progress-layout', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(baseValue(Array.from(progress.cssRules), '.progress-logs', 'max-height')).toBe('none');
  });

  it('has no conflicting selector properties within the same media condition', () => {
    expect(mediaConflicts(rules)).toEqual([]);
  });

  it.each([true, false])('detects conflicting progress log heights across media blocks: %s', separateBlocks => {
    const fixture = parseRules(`
      @media (max-width: 1100px) {
        .progress-logs { max-height: 300px; }
        ${separateBlocks ? '} @media (max-width: 1100px) {' : ''}
        .other, .progress-logs { max-height: none; }
      }
    `);
    expect(mediaConflicts(fixture)).toEqual(['(max-width: 1100px) | .progress-logs | max-height: 300px -> none']);
  });

  it('allows different breakpoint values and repeated identical media declarations', () => {
    expect(mediaConflicts(parseRules(`
      .progress-logs { max-height: 450px; }
      @media (max-width: 1100px) { .progress-logs { max-height: none; } }
      @media (max-width: 1100px) { .progress-logs { max-height: none; } }
      @media (max-width: 700px) { .progress-logs { max-height: 300px; } }
    `))).toEqual([]);
  });

  it('accepts indented, combined selectors and harmless media overrides', () => {
    const fixture = parseRules(`
      .chat-panel,
      .transcript { min-height: 0; overflow: auto; }
      @media (max-width: 850px) {
        .transcript, .split .transcript { min-height: 0; overflow: auto; padding: 12px; }
        .transcript-heading { min-height: 20px; overflow: hidden; }
      }
    `);
    expect(baseValue(fixture, '.transcript', 'min-height')).toBe('0');
    expect(baseValue(fixture, '.transcript', 'overflow')).toBe('auto');
    expect(mediaViolations(fixture)).toEqual([]);
  });

  it.each(['min-height: 100px', 'overflow: hidden', 'overflow-y: hidden'])(
    'detects a nested media regression: %s',
    declaration => {
      const fixture = parseRules(`
        .transcript { min-height: 0; overflow: auto; }
        @media (max-width: 850px) {
          @media (max-height: 700px) {
            .other, .split .transcript { ${declaration}; }
          }
        }
      `);
      expect(mediaViolations(fixture)).toEqual([`.other, .split .transcript: ${declaration}`]);
    },
  );
});
