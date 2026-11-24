import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/ledger.js";
import { tick, resetClock, healthyChain, allSampledRules } from "./helpers.js";

test("同一 sink 的重复后端日志被识别并按 requestId/attempt 聚合", () => {
  resetClock();
  const events = [
    ...healthyChain("dup-1", 1),
    { type: "backend_log", at: tick(), requestId: "dup-1", attempt: 0, seq: 99 },
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const backendDup = report.duplicates.find((item) => item.sink === "backend");
  assert.ok(backendDup);
  assert.equal(backendDup.observedCount, 2);
  assert.equal(backendDup.duplicateCount, 1);
  assert.deepEqual(backendDup.logSeq, [12, 99]);
  assert.equal(report.summary.duplicateLogLines, 1);
});

test("duplicate_send 事件与实际重复日志关联，缓冲重复同样可见", () => {
  resetClock();
  const events = [
    { type: "entry", at: tick(), seq: 1, requestId: "d1", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "d1", attempt: 0, sampled: true, ruleId: "all" },
    { type: "enqueue", at: tick(), requestId: "d1", attempt: 0, seq: 11 },
    { type: "enqueue", at: tick(), requestId: "d1", attempt: 0, seq: 12 },
    { type: "flush", at: tick(), requestId: "d1", attempt: 0, batchId: "b1" },
    { type: "duplicate_send", at: tick(), requestId: "d1", attempt: 0, sink: "backend", seq: 13 },
    { type: "response", at: tick(), requestId: "d1", attempt: 0, status: 200 },
    { type: "backend_log", at: tick(), requestId: "d1", attempt: 0, seq: 14 },
    { type: "backend_log", at: tick(), requestId: "d1", attempt: 0, seq: 15 },
    { type: "billing_log", at: tick(), requestId: "d1", attempt: 0, seq: 16 },
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const bufferDup = report.duplicates.find((item) => item.sink === "buffer" && item.logSeq.includes(12));
  const backendDup = report.duplicates.find((item) => item.sink === "backend");
  assert.ok(bufferDup, "enqueue 重复需要报告");
  assert.ok(backendDup);
  assert.deepEqual(backendDup.duplicateSendSeq, [13]);
  assert.equal(report.summary.lost, 0, "重复不影响完整性判定");
});

test("计费日志重复单独计入 billing sink", () => {
  resetClock();
  const events = [
    ...healthyChain("bill-1", 1),
    { type: "billing_log", at: tick(), requestId: "bill-1", attempt: 0, seq: 77 },
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const billingDup = report.duplicates.find((item) => item.sink === "billing");
  assert.equal(billingDup.duplicateCount, 1);
});

test("不同 attempt 的同 requestId 日志不互相算作重复", () => {
  resetClock();
  const events = [
    ...healthyChain("m1", 1, { attempt: 0 }),
    ...healthyChain("m1", 1, { attempt: 1 }),
  ];
  const report = reconcile({ rules: allSampledRules, events });
  assert.equal(report.duplicates.length, 0);
  const request = report.requests.find((item) => item.requestId === "m1");
  assert.deepEqual(request.retryOf, [1]);
});
