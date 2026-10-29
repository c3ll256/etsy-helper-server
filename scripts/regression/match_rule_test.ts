/**
 * SKU 匹配规则、图标编号提取的回归测试（不连数据库）。
 * 运行：npx ts-node -T scripts/regression/match_rule_test.ts
 */
import 'reflect-metadata';
import * as assert from 'assert';
import { TemplateMatchService } from '../../src/stamps/services/template-match.service';
import { extractIconCodes } from '../../src/stamps/services/order-stamp.service';
import { OrderMatchStatus } from '../../src/orders/enums/order.enum';

const svc = new TemplateMatchService(null as any, null as any);
const t = (id: number, skus: string[], extra: Record<string, any> = {}) => ({ id, name: `T${id}`, skus, type: 'steel_zhuoda', ...extra }) as any;

const templates = [
  t(732, ['WD-005-ZD']),
  t(987, ['WD-204-ZD']),
  t(1, ['AD-210']),
  t(2, ['AD-210-ZDC']),
  t(3, ['BG-122']),
  t(4, ['BG-202']),
  t(5, ['DUP-1']),
  t(6, ['DUP-1']),
  t(7, ['Rattle001-Bunny-Font1'], { type: 'rattle', allowMultipleForSku: true }),
  t(8, ['Rattle001-Bunny-Font1'], { type: 'rattle', allowMultipleForSku: true }),
];

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

process.env.SKU_MATCH_MODE = 'exact_or_suffix';
delete process.env.SKU_MATCH_CASE_SENSITIVE;

check('S1.1 WD-204-ZD-black 只匹配 WD-204-ZD，不会匹配 WD-005-ZD', () => {
  const r = svc.matchAgainst('WD-204-ZD-black', templates);
  assert.strictEqual(r.status, OrderMatchStatus.EXACT);
  assert.strictEqual(r.template.id, 987);
});

check('完全相同优先于后缀匹配', () => {
  const r = svc.matchAgainst('AD-210-ZDC', templates);
  assert.strictEqual(r.template.id, 2);
});

check('后缀匹配取最长的模板 SKU（AD-210-JD → AD-210）', () => {
  const r = svc.matchAgainst('AD-210-JD', templates);
  assert.strictEqual(r.template.id, 1);
});

check('BG-122-Y43-S → BG-122（不会因为共享 BG 去配 BG-202）', () => {
  assert.strictEqual(svc.matchAgainst('BG-122-Y43-S', templates).template.id, 3);
});

check('S1.2 没有符合规则的模板 → 未匹配，不做模糊匹配', () => {
  assert.strictEqual(svc.matchAgainst('WD-999-ZD', templates).status, OrderMatchStatus.UNMATCHED);
  assert.strictEqual(svc.matchAgainst('WD-204', templates).status, OrderMatchStatus.UNMATCHED);
  // 前缀必须以连字符为界：WD-204-ZDX 不是 WD-204-ZD 的后缀写法
  assert.strictEqual(svc.matchAgainst('WD-204-ZDX', templates).status, OrderMatchStatus.UNMATCHED);
});

check('S1.3 同样符合的模板有多个 → 冲突，不默认选第一个', () => {
  const r = svc.matchAgainst('DUP-1-black', templates);
  assert.strictEqual(r.status, OrderMatchStatus.CONFLICT);
  assert.deepStrictEqual(r.detail.candidates.map(c => c.templateId).sort(), [5, 6]);
  assert.notStrictEqual(r.detail.reason, 'multi_template');
});

check('R1 多模板模式的摇铃 → 多模板待选择', () => {
  const r = svc.matchAgainst('Rattle001-Bunny-Font1', templates);
  assert.strictEqual(r.status, OrderMatchStatus.CONFLICT);
  assert.strictEqual(r.detail.reason, 'multi_template');
});

check('大小写和首尾空格默认不区分', () => {
  assert.strictEqual(svc.matchAgainst('  wd-204-zd-BLACK ', templates).template.id, 987);
});

check('SKU_MATCH_CASE_SENSITIVE=true 时区分大小写', () => {
  process.env.SKU_MATCH_CASE_SENSITIVE = 'true';
  assert.strictEqual(svc.matchAgainst('wd-204-zd-black', templates).status, OrderMatchStatus.UNMATCHED);
  delete process.env.SKU_MATCH_CASE_SENSITIVE;
});

check('SKU_MATCH_MODE=exact 时只认完全相同', () => {
  process.env.SKU_MATCH_MODE = 'exact';
  assert.strictEqual(svc.matchAgainst('WD-204-ZD-black', templates).status, OrderMatchStatus.UNMATCHED);
  assert.strictEqual(svc.matchAgainst('WD-204-ZD', templates).template.id, 987);
  process.env.SKU_MATCH_MODE = 'exact_or_suffix';
});

check('空 SKU → 未匹配', () => {
  assert.strictEqual(svc.matchAgainst('', templates).status, OrderMatchStatus.UNMATCHED);
});

check('C6 图标编号按完整编号提取，不拆字母、保留重复和顺序', () => {
  assert.deepStrictEqual(extractIconCodes('icon - A5'), ['A5']);
  assert.deepStrictEqual(extractIconCodes('(just icons) A2, A9, A1'), ['A2', 'A9', 'A1']);
  assert.deepStrictEqual(extractIconCodes('C10'), ['C10']);
  assert.deepStrictEqual(extractIconCodes('a-3 and A3'), ['A3', 'A3']);
  assert.deepStrictEqual(extractIconCodes('Thea~Hazel'), []);
});

console.log(`\n${passed} passed`);
