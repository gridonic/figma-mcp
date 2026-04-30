import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFontString } from './sync-design-tokens.js';

test('parseFontString parses single-word style values', () => {
  const parsed = parseFontString(
    'Font(family: "Inter", style: Medium, size: 16, weight: 500, lineHeight: 1.5, letterSpacing: 0)'
  );

  assert.deepEqual(parsed, {
    fontFamily: 'Inter',
    fontSize: 16,
    fontWeight: 500,
    lineHeight: 1.5,
    letterSpacing: 0,
  });
});

test('parseFontString parses multi-word style values', () => {
  const parsed = parseFontString(
    'Font(family: "PP Neue Machina", style: Plain Medium, size: 14, weight: 500, lineHeight: 1.2, letterSpacing: -0.14)'
  );

  assert.deepEqual(parsed, {
    fontFamily: 'PP Neue Machina',
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1.2,
    letterSpacing: -0.14,
  });
});
