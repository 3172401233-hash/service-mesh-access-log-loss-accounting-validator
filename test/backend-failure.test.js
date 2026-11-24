import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/ledger.js";
import { tick, resetClock, healthyChain, allSampledRules, findLoss } from "./helpers.js";

test("后端 5xx 响应归类为 backend_failure 而非采样", () => {
  resetClock();
  const events = [
    { type: "entry", at: tick(), seq: 1, requestId: "e1", attempt: 0, path: "/api", method: "POST", status: 503 },
    { type: "sample", at: tick(), requestId: "e1", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "e1", attempt: 0, seq: 11 },
    { type: "flush", at: tick(), requestId: "e1", attempt: 0, batchId: "b1" },
    { type: "response", at: tick(), requestId: "e1", attempt: 0, status: 503 },
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const loss = findLoss(report, "backend_failure");
  assert.ok(loss);
  assert.equal(loss.requests[0].status, 503);
  assert.equal(report.summary.samplingMismatches, 0);
});

test("刷盘后无响应也无后端日志 -> inflight_loss 与 no_backend_log 的边界", () => {
  resetClock();
  const noResponse = [
    { type: "entry", at: tick(), seq: 1, requestId: "f1", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "f1", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "f1", attempt: 0, seq: 11 },
    { type: "flush", at: tick(), requestId: "f1", attempt: 0, batchId: "b1" },
  ];
  const reportA = reconcile({ rules: allSampledRules, events: noResponse });
  assert.ok(findLoss(reportA, "inflight_loss"));

  resetClock();
  const noBackendLog = [
    { type: "entry", at: tick(), seq: 2, requestId: "f2", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "f2", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "f2", attempt: 0, seq: 21 },
    { type: "flush", at: tick(), requestId: "f2", attempt: 0, batchId: "b2" },
    { type: "response", at: tick(), requestId: "f2", attempt: 0, status: 200 },
  ];
  const reportB = reconcile({ rules: allSampledRules, events: noBackendLog });
  assert.ok(findLoss(reportB, "no_backend_log"));
});

test("有后端日志但缺计费日志 -> no_billing_log，阶段标记为 billing", () => {
  resetClock();
  const events = healthyChain("c1", 1).filter((event) => event.type !== "billing_log");
  const report = reconcile({ rules: allSampledRules, events });
  const loss = findLoss(report, "no_billing_log");
  assert.ok(loss);
  assert.equal(loss.stage, "billing");
});

test("入缓冲后从未刷盘且无重启 -> unflushed_loss", () => {
  resetClock();
  const events = [
    { type: "entry", at: tick(), seq: 1, requestId: "q1", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "q1", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "q1", attempt: 0, seq: 11 },
  ];
  const report = reconcile({ rules: allSampledRules, events });
  assert.ok(findLoss(report, "unflushed_loss"));
  assert.equal(findLoss(report, "restart_loss"), undefined);
});

test("下游日志缺少入口事件 -> 不可归因请求；无 requestId 事件 -> 不可归因事件", () => {
  resetClock();
  const events = [
    { type: "backend_log", at: tick(), requestId: "ghost", attempt: 0, seq: 1 },
    { type: "billing_log", at: tick(), requestId: "ghost", attempt: 0, seq: 2 },
    { type: "backend_log", at: tick(), seq: 3 },
    ...healthyChain("real", 4),
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const ghost = report.unattributableRequests.find((item) => item.requestId === "ghost");
  assert.ok(ghost);
  assert.equal(ghost.reason, "downstream_log_without_entry");
  assert.equal(ghost.attempts[0].backendLogs, 1);
  assert.equal(report.summary.unattributableRequests, 1);
  assert.equal(report.summary.unattributableEvents, 1);
  assert.equal(report.unattributable[0].reason, "missing_request_id");
  const ghostInLossBucket = report.losses.some((bucket) =>
    bucket.requests.some((item) => item.requestId === "ghost"),
  );
  assert.equal(ghostInLossBucket, false, "无入口的下游日志不能进入阶段丢失桶");
  const ghostAttempt = report.requests.find((item) => item.requestId === "ghost").attempts[0];
  assert.equal(ghostAttempt.lost.stage, "unattributable");
});

test("混合场景一次性产出多阶段丢失区间", () => {
  resetClock();
  const events = [
    ...healthyChain("ok", 1),
    { type: "entry", at: tick(), seq: 2, requestId: "buf", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "buf", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "buf", attempt: 0, seq: 21 },
    { type: "entry", at: tick(), seq: 3, requestId: "boom", attempt: 0, path: "/api", method: "POST", status: 500 },
    { type: "sample", at: tick(), requestId: "boom", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "boom", attempt: 0, seq: 31 },
    { type: "flush", at: tick(), requestId: "boom", attempt: 0, batchId: "b3" },
    { type: "response", at: tick(), requestId: "boom", attempt: 0, status: 500 },
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const reasons = report.losses.map((loss) => loss.reason).sort();
  assert.deepEqual(reasons, ["backend_failure", "unflushed_loss"]);
  assert.equal(report.summary.entryRequests, 3);
  assert.equal(report.summary.completedSampled, 1);
});
