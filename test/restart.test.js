import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/ledger.js";
import { tick, resetClock, healthyChain, allSampledRules, findLoss } from "./helpers.js";

test("进程重启时仍在写缓冲中的 attempt 记为 restart_loss", () => {
  resetClock();
  const events = [
    ...healthyChain("ok-1", 1),
    { type: "entry", at: tick(), seq: 2, requestId: "lost-1", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "lost-1", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "lost-1", attempt: 0, seq: 21 },
    { type: "restart", at: tick(), restartId: "rst-1" },
    ...healthyChain("ok-3", 3),
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const loss = findLoss(report, "restart_loss");
  assert.ok(loss, "重启丢失必须被显式报告");
  assert.deepEqual(loss.entrySeqRanges, [{ from: 2, to: 2 }]);
  assert.deepEqual(loss.requests[0].restartIds, ["rst-1"]);
  assert.equal(report.summary.restarts, 1);
  assert.equal(report.summary.completedSampled, 2);
});

test("重启后的重试 attempt 成功时不重复计丢失，attempt 关系保留", () => {
  resetClock();
  const events = [
    { type: "entry", at: tick(), seq: 1, requestId: "r1", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "r1", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "r1", attempt: 0, seq: 11 },
    { type: "restart", at: tick(), restartId: "rst-9" },
    { type: "entry", at: tick(), seq: 1, requestId: "r1", attempt: 1, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "r1", attempt: 1, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "r1", attempt: 1, seq: 12 },
    { type: "flush", at: tick(), requestId: "r1", attempt: 1, batchId: "b-1" },
    { type: "response", at: tick(), requestId: "r1", attempt: 1, status: 200 },
    { type: "backend_log", at: tick(), requestId: "r1", attempt: 1, seq: 13 },
    { type: "billing_log", at: tick(), requestId: "r1", attempt: 1, seq: 14 },
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const loss = findLoss(report, "restart_loss");
  assert.equal(loss.count, 1, "只有 attempt 0 丢失");
  assert.equal(loss.requests[0].attempt, 0);

  const request = report.requests.find((item) => item.requestId === "r1");
  assert.deepEqual(request.retryOf, [1]);
  assert.equal(request.attempts.length, 2);
  assert.equal(request.attempts[0].lost.reason, "restart_loss");
  assert.equal(request.attempts[1].lost, null);
});

test("已刷盘的 attempt 不受后续重启影响", () => {
  resetClock();
  const events = [
    ...healthyChain("safe-1", 1),
    { type: "restart", at: tick(), restartId: "rst-2" },
    ...healthyChain("safe-2", 2),
  ];
  const report = reconcile({ rules: allSampledRules, events });
  assert.equal(findLoss(report, "restart_loss"), undefined);
  assert.equal(report.summary.completedSampled, 2);
});

test("多个重启丢失被压缩成连续入口序号区间", () => {
  resetClock();
  const events = [
    ...healthyChain("ok", 1),
    { type: "entry", at: tick(), seq: 2, requestId: "x2", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "x2", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "x2", attempt: 0, seq: 21 },
    { type: "entry", at: tick(), seq: 3, requestId: "x3", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "x3", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "x3", attempt: 0, seq: 31 },
    { type: "restart", at: tick(), restartId: "rst-3" },
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const loss = findLoss(report, "restart_loss");
  assert.deepEqual(loss.entrySeqRanges, [{ from: 2, to: 3 }]);
  assert.equal(loss.entrySeqRangeText, "2-3");
});
