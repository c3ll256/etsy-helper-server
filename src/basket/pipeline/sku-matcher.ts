import { MatchStatus, SkuConfigLike } from './types';

/**
 * 订单 SKU → SKU 配置的唯一匹配入口（母婴）。
 *
 * 规则（严格、可解释，不做模糊匹配）：
 * 1. 只做首尾空格的去除，大小写和其他字符都必须一致。
 * 2. 订单 SKU 与配置 SKU 完全相同 → exact。
 * 3. 否则：订单 SKU 以「配置 SKU + 分隔符」开头 → prefix。分隔符只认 `-`、`+`、空格
 *    （生产数据里的后缀写法：`LZ-L-Mix-2`、`Bag001-Pink+Box`、`SB1-Rose + Icon-Mix-2`）。
 *    - 末尾括号里的款式标记（如 `(I)`）必须一致：`Set2-Pink-Strawberry(I)` 不能匹配 `Set2-Pink`
 *    - 多个候选时取最长的配置 SKU
 * 4. 同一长度的候选不止一条（例如同一账号下同一 SKU 有两条配置，一条单品一条套组）→ conflict。
 * 5. 都没有 → unmatched，附上最接近的配置（只作提示，不使用）。
 *
 * 不再使用 `includes`：`Bag-Pink1` 不会命中 `MB1-Pink`，`Bag-Blue1` 不会命中 `Bag-Blue`。
 */
export interface SkuMatchResult {
  status: MatchStatus;
  config: SkuConfigLike | null;
  candidates: SkuConfigLike[];
  note: string | null;
}

const SEPARATORS = new Set(['-', '+', ' ']);

function trailingMarker(sku: string): string {
  const m = sku.match(/\(([^()]*)\)\s*$/);
  return m ? m[1].trim() : '';
}

export function matchSkuConfig(orderSkuRaw: string, configs: SkuConfigLike[]): SkuMatchResult {
  const orderSku = String(orderSkuRaw || '').trim();
  if (!orderSku) {
    return { status: 'unmatched', config: null, candidates: [], note: '订单行没有 SKU' };
  }

  const exact = configs.filter((c) => String(c.sku || '').trim() === orderSku);
  if (exact.length === 1) {
    return { status: 'exact', config: exact[0], candidates: exact, note: null };
  }
  if (exact.length > 1) {
    return {
      status: 'conflict',
      config: null,
      candidates: exact,
      note: `SKU ${orderSku} 有 ${exact.length} 条配置（${describe(exact)}），请删除多余配置或上传时选择订单类型`,
    };
  }

  const orderMarker = trailingMarker(orderSku);
  const prefixCandidates = configs.filter((c) => {
    const s = String(c.sku || '').trim();
    if (!s || s.length >= orderSku.length) return false;
    if (!orderSku.startsWith(s)) return false;
    if (!SEPARATORS.has(orderSku[s.length])) return false;
    return trailingMarker(s) === orderMarker;
  });

  if (prefixCandidates.length) {
    const longest = Math.max(...prefixCandidates.map((c) => c.sku.trim().length));
    const best = prefixCandidates.filter((c) => c.sku.trim().length === longest);
    if (best.length === 1) {
      return {
        status: 'prefix',
        config: best[0],
        candidates: best,
        note: `按前缀匹配到 ${best[0].sku}（订单 SKU 多出后缀 "${orderSku.slice(best[0].sku.trim().length)}"）`,
      };
    }
    return {
      status: 'conflict',
      config: null,
      candidates: best,
      note: `前缀 ${best[0].sku.trim()} 有 ${best.length} 条配置（${describe(best)}）`,
    };
  }

  const hint = nearestHint(orderSku, configs);
  return {
    status: 'unmatched',
    config: null,
    candidates: [],
    note: hint ? `未配置 SKU ${orderSku}；相近的配置 ${hint}（未使用，规则不做模糊匹配）` : `未配置 SKU ${orderSku}`,
  };
}

function describe(list: SkuConfigLike[]): string {
  return list.map((c) => `#${c.id} ${c.type}${c.replaceValue ? ' ' + c.replaceValue : ''}`).join('，');
}

/** 只作为异常提示：去掉末尾括号标记后相同，或被订单 SKU 包含的最长配置 */
function nearestHint(orderSku: string, configs: SkuConfigLike[]): string | null {
  const base = orderSku.replace(/\([^()]*\)\s*$/, '').trim();
  const sameBase = configs.find((c) => c.sku.trim().replace(/\([^()]*\)\s*$/, '').trim() === base);
  if (sameBase) return sameBase.sku;
  const contained = configs
    .filter((c) => c.sku && c.sku.trim().length >= 4 && orderSku.includes(c.sku.trim()))
    .sort((a, b) => b.sku.length - a.sku.length)[0];
  return contained ? contained.sku : null;
}
