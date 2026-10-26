'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/styles.css'), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = Array.from(css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g')));
  assert.ok(matches.length, `${selector} rule should exist`);
  return matches.at(-1)[1];
}

function declaration(body, property) {
  return body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`))?.[1].trim() || '';
}

test('short Trends panels scroll to their summary cards instead of clipping them', () => {
  const panel = rule('.trends-panel');
  const overflow = declaration(panel, 'overflow').split(/\s+/);
  assert.equal(overflow[0], 'hidden', 'a narrow chart must not force horizontal scrolling');
  assert.equal(overflow[1], 'auto', 'summary cards must remain reachable when the window is short or zoomed');
});

test('a short or zoomed window cannot shrink the Trends chart into its padding', () => {
  const spark = rule('.trends-spark');
  const minHeight = declaration(spark, 'min-height');
  assert.match(minHeight, /^\d+px$/);
  assert.ok(parseFloat(minHeight) >= 64, 'reserve visible plot space beyond the vertical padding');
  assert.equal(declaration(spark, 'flex').split(/\s+/)[1], '0', 'fixed summary rows must not consume the plot height');
});
