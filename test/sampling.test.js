import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedDecision, hashKey } from "../src/sampling.js";

const rules = {
  rules: [
    { id: "errors", pathPrefix: "/pay", statusMin: 500, sampled: true },
    { id: "half", pathPrefix: "/api", percent: 50 },
    { id: "health-off", pathPrefix: "/health", sampled: false },
  ],
  default: { id: "default-off", sampled: false },
};

test("哈希对同一 key 稳定且分布在 32 位无符号区间", () => {
  const a = hashKey("req-1");
  const b = hashKey("req-1");
  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 0xffffffff);
});

test("100% 与显式关闭规则", () => {
  assert.equal(
    expectedDecision(rules, { requestId: "r1", path: "/pay/x", method: "POST", status: 503 }).sampled,
    true,
  );
  assert.equal(
    expectedDecision(rules, { requestId: "r2", path: "/health", method: "GET", status: 200 }).sampled,
    false,
  );
});

test("百分比采样对同一 requestId 重放结果一致", () => {
  const event = { requestId: "stable-id", path: "/api/x", method: "GET", status: 200 };
  const first = expectedDecision(rules, event);
  const second = expectedDecision(rules, event);
  assert.equal(first.sampled, second.sampled);
  assert.equal(first.ruleId, "half");
});

test("50% 规则在一批 key 上既存在命中也存在未命中", () => {
  const decisions = new Set();
  for (let i = 0; i < 200; i += 1) {
    decisions.add(
      expectedDecision(rules, { requestId: `mix-${i}`, path: "/api", method: "GET", status: 200 }).sampled,
    );
  }
  assert.deepEqual([...decisions].sort(), [false, true]);
});

test("未命中任何规则时使用默认规则", () => {
  const decision = expectedDecision(rules, { requestId: "r9", path: "/other", method: "GET", status: 200 });
  assert.equal(decision.sampled, false);
  assert.equal(decision.ruleId, "default-off");
});
