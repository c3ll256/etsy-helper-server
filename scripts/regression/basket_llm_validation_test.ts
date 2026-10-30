/**
 * 母婴 LLM 兜底结果的校验（合成数据，句式取自真实上传里出过错的情况）。
 * 运行：npx ts-node --transpile-only -P tsconfig.json scripts/regression/basket_llm_validation_test.ts
 */
import * as assert from 'assert';
import { IconIndex } from '../../src/basket/pipeline/icon-index';
import { splitFields } from '../../src/basket/pipeline/variation-parser';
import { validateLlmItems } from '../../src/basket/pipeline/llm-fallback';

const index = new IconIndex([]);
let passed = 0;
function check(name: string, raw: string, llmName: string, expectOk: boolean) {
  const { fields } = splitFields(raw);
  const v = validateLlmItems({ items: [{ name: llmName, icons: [] }] }, raw, index, fields);
  assert.strictEqual(v.ok, expectOk, `${name}: ${JSON.stringify(v.errors)}`);
  passed++;
  console.log(`ok - ${name}${v.ok ? '' : `（拦截：${v.errors[0]}）`}`);
}

check('款式选项值不能当名字', 'Product CombinationLunch Bag\nName Color01 Cream\nPersonalizationAvery Stone- same as previous', 'Lunch Bag', false);
check('套组名不能当名字', 'Product CombinationPink Set\nName ColorYR2-Blush\nPersonalizationWren (please do not join up the r and n)', 'Pink Set', false);
check('整句说明不能当名字', 'Basket SizeL\nYarn ColorMulticolor 7\n1. Nameno name just flowers to go along with the first basket pls', 'no name just flowers to go along with the first basket pls', false);
check('混着商品说明的不能当名字', 'Product CombinationCustom Color Set\nPersonalizationBeige backpack and beige plaid lunch bag. Theo, ZB', 'Beige backpack and beige plaid lunch bag. Theo, ZB', false);
check('定制字段里的真实名字可以通过', 'Product CombinationLunch Bag\nName Color01 Cream\nPersonalizationAvery Stone- same as previous', 'Avery Stone', true);
check('带重音的名字可以通过', 'Bag ColorMint\nPersonalization\n1. Sebastián\n2. rainbow', 'Sebastián', true);
console.log(`\n${passed} passed`);
