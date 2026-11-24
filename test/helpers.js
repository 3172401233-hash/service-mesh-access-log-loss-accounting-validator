let clock = 0;

export function tick(step = 10) {
  clock += step;
  return `2026-11-24T02:00:${String(clock).padStart(2, "0")}.000Z`;
}

export function resetClock() {
  clock = 0;
}

/**
 * 构造一条走完所有阶段的健康链路。
 */
export function healthyChain(requestId, seq, overrides = {}) {
  const attempt = overrides.attempt ?? 0;
  const path = overrides.path ?? "/api/x";
  return [
    { type: "entry", at: tick(), seq, requestId, attempt, path, method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId, attempt, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId, attempt, seq: seq * 10 + 1 },
    { type: "flush", at: tick(), requestId, attempt, batchId: overrides.batchId ?? `b-${seq}` },
    { type: "response", at: tick(), requestId, attempt, status: 200 },
    { type: "backend_log", at: tick(), requestId, attempt, seq: seq * 10 + 2 },
    { type: "billing_log", at: tick(), requestId, attempt, seq: seq * 10 + 3 },
  ];
}

export const allSampledRules = {
  rules: [{ id: "all", percent: 100 }],
  default: { id: "default", sampled: true, percent: 100 },
};

export function findLoss(report, reason) {
  return report.losses.find((loss) => loss.reason === reason);
}
