import test from 'node:test';
import assert from 'node:assert/strict';

import { replaceSkuDisplayValue } from './sku-display.util.ts';

test('replaceSkuDisplayValue preserves original SKU when replacement text is empty', () => {
  assert.equal(
    replaceSkuDisplayValue('ABC() + 深蓝1', 'ABC', ''),
    'ABC() + 深蓝1',
  );
});

test('replaceSkuDisplayValue preserves original SKU when replacement text is null', () => {
  assert.equal(
    replaceSkuDisplayValue('ABC() + 深蓝1', 'ABC', null),
    'ABC() + 深蓝1',
  );
});

test('replaceSkuDisplayValue replaces matched SKU when replacement text is present', () => {
  assert.equal(
    replaceSkuDisplayValue('ABC() + 深蓝1', 'ABC', 'Lunch Bag'),
    'Lunch Bag() + 深蓝1',
  );
});
