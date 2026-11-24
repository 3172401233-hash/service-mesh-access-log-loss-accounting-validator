/**
 * 采样规则引擎。
 *
 * 规则只决定“入口请求是否应当被记录”，绝不能用来解释后续阶段的丢失：
 * 一旦某个 attempt 被判定为 sampled，缓冲、刷盘、后端、计费任一阶段缺日志都是错误。
 *
 * 规则按数组顺序匹配，第一条命中的规则生效；全部未命中时取默认规则。
 * 采用确定性 FNV-1a 哈希做百分比采样，保证同一 requestId 重放结果一致。
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function hashKey(key) {
  let hash = FNV_OFFSET;
  const bytes = Buffer.from(String(key), "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

function matchRule(rule, event) {
  if (rule.pathPrefix && !String(event.path ?? "").startsWith(rule.pathPrefix)) {
    return false;
  }
  if (rule.method && rule.method !== (event.method ?? "GET")) {
    return false;
  }
  if (rule.statusMin !== undefined && (event.status ?? 0) < rule.statusMin) {
    return false;
  }
  if (rule.statusMax !== undefined && (event.status ?? 0) > rule.statusMax) {
    return false;
  }
  return true;
}

/**
 * 根据规则计算入口事件的期望采样决策。
 * 返回 { sampled: boolean, ruleId: string, percent: number }。
 */
export function expectedDecision(rules, event) {
  const list = rules?.rules ?? rules ?? [];
  const fallback = rules?.default ?? { sampled: false };

  for (const rule of list) {
    if (!matchRule(rule, event)) {
      continue;
    }
    if (rule.sampled === false) {
      return { sampled: false, ruleId: rule.id, percent: 0 };
    }
    const percent = rule.percent ?? 100;
    if (percent >= 100) {
      return { sampled: true, ruleId: rule.id, percent: 100 };
    }
    if (percent <= 0) {
      return { sampled: false, ruleId: rule.id, percent: 0 };
    }
    const bucket = hashKey(event.requestId) % 100;
    return { sampled: bucket < percent, ruleId: rule.id, percent };
  }

  if (fallback.sampled === false) {
    return { sampled: false, ruleId: fallback.id ?? "default", percent: 0 };
  }
  const percent = fallback.percent ?? 100;
  if (percent <= 0) {
    return { sampled: false, ruleId: fallback.id ?? "default", percent: 0 };
  }
  if (percent >= 100) {
    return { sampled: true, ruleId: fallback.id ?? "default", percent: 100 };
  }
  const bucket = hashKey(event.requestId) % 100;
  return { sampled: bucket < percent, ruleId: fallback.id ?? "default", percent };
}
