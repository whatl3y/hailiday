import { afterEach, describe, expect, it } from 'vitest';
import globalCss from '../../styles/global.css?raw';
import tokensCss from '../../styles/tokens.css?raw';
import accountCss from '../account/account.css?raw';
import landingCss from '../landing/landing.css?raw';
import optOutPage from './OptOutPage.tsx?raw';
import reportCss from './report.css?raw';
import reportSheet from './ReportSheet.tsx?raw';

const plain = reportCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const start = plain.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = plain.indexOf('{', start);
  return plain.slice(open + 1, plain.indexOf('}', open));
}

describe('the report reasons', () => {
  it('live in the report stylesheet that the sheet imports', () => {
    expect(reportSheet).toContain("import './report.css';");
    expect(reportSheet).not.toContain('account.css');
    expect(accountCss).not.toMatch(/radio-row|report-reasons/);
  });

  it('form one framed list: rows share their hairlines and round only the outer corners', () => {
    expect(rule('.radio-row')).toMatch(/border: 1px solid var\(--line\);/);
    expect(rule('.radio-row + .radio-row')).toMatch(/margin-top: -1px;/);
    expect(rule('.radio-row:first-of-type')).toMatch(
      /border-radius: var\(--radius-m\) var\(--radius-m\) 0 0;/,
    );
    expect(rule('.radio-row:last-of-type')).toMatch(
      /border-radius: 0 0 var\(--radius-m\) var\(--radius-m\);/,
    );
  });

  it('mark the chosen reason in ink, never with a colored accent', () => {
    expect(rule('.radio-row:has(input:checked)')).toMatch(
      /box-shadow: inset 2px 0 0 var\(--ink\);/,
    );
    expect(rule('.radio-row input')).toMatch(/accent-color: var\(--ink\);/);
    expect(plain).not.toMatch(/--accent/);
    expect(rule('.radio-row')).toMatch(/min-height: var\(--target-comfort\);/);
  });
});

describe("Don't decorate my home", () => {
  it('keeps the action at its own width', () => {
    expect(optOutPage).toContain('simple-page optout stack');
    expect(optOutPage).toContain("import './report.css';");
    expect(rule('.optout form > .button--primary')).toMatch(/align-self: flex-start;/);
  });
});

describe("Don't decorate my home in the cascade", () => {
  afterEach(() => {
    document.head.querySelector('style[data-test="optout-cascade"]')?.remove();
    document.body.innerHTML = '';
  });

  it('takes its label style and its stack gaps from the base stylesheet alone', () => {
    expect(plain).not.toMatch(/\.optout \.stack|\.optout \.field__label|--stack-gap/);
    const style = document.createElement('style');
    style.dataset.test = 'optout-cascade';
    style.textContent = [
      tokensCss,
      globalCss.replace(/^@import [^;]+;$/gm, ''),
      landingCss,
      reportCss,
    ].join('\n');
    document.head.append(style);
    document.body.innerHTML = [
      '<section class="container container--narrow simple-page optout stack stack--loose">',
      '<div class="stack" id="intro"><h1 class="simple-page__title">Title</h1></div>',
      '<form class="stack"><label class="combo__label">Address</label>',
      '<div class="field"><label class="field__label">Email</label><input class="input"></div>',
      '<button class="button button--primary">Send</button></form></section>',
    ].join('');
    const page = getComputedStyle(document.querySelector('.optout')!);
    expect(page.rowGap).toBe('32px');
    for (const inner of document.querySelectorAll('#intro, .optout form')) {
      expect(getComputedStyle(inner).rowGap, inner.tagName).toBe('16px');
    }
    // The email label is set as the address label is: 11px uppercase in the muted ink.
    const label = getComputedStyle(document.querySelector('.field__label')!);
    const address = getComputedStyle(document.querySelector('.combo__label')!);
    for (const property of [
      'fontSize',
      'fontWeight',
      'letterSpacing',
      'textTransform',
      'color',
      'paddingLeft',
      'paddingRight',
    ] as const) {
      expect(label[property], property).toBe(address[property]);
    }
    expect(label.textTransform).toBe('uppercase');
    expect(label.fontSize).toBe('11px');
    expect(label.paddingLeft).toBe('2px');
  });
});

describe("Don't decorate my home fields", () => {
  afterEach(() => {
    document.head.querySelector('style[data-test="optout"]')?.remove();
    document.body.innerHTML = '';
  });

  it('draws the address field like the email field under it: flat, as tall, 16px text', () => {
    // The real cascade: the address field's landing look, then this page's rules.
    const style = document.createElement('style');
    style.dataset.test = 'optout';
    style.textContent = [
      tokensCss,
      globalCss.replace(/^@import [^;]+;$/gm, ''),
      landingCss,
      reportCss,
    ].join('\n');
    document.head.append(style);
    document.body.innerHTML = [
      '<section class="optout"><div class="combo__field"><input class="combo__input"></div>',
      '<input class="input"></section>',
      '<div class="combo__field" id="landing"><input class="combo__input"></div>',
    ].join('');
    const field = getComputedStyle(document.querySelector('.optout .combo__field')!);
    const address = getComputedStyle(document.querySelector('.optout .combo__input')!);
    const email = getComputedStyle(document.querySelector('.optout .input')!);
    expect(field.boxShadow).toBe('none');
    // The input's height plus the field's border on either side is the email field's height,
    // whose border is its own.
    const px = (value: string) => Number.parseFloat(value);
    expect(px(address.minHeight) + px(field.borderTopWidth) + px(field.borderBottomWidth)).toBe(
      px(email.minHeight),
    );
    expect(email.minHeight).toBe('52px');
    expect(address.fontSize).toBe('16px');
    // The landing keeps its own larger, raised address field.
    expect(getComputedStyle(document.querySelector('#landing')!).boxShadow).not.toBe('none');
    expect(rule('.optout .combo__field:focus-within')).toMatch(/box-shadow: var\(--ring\);/);
  });
});
