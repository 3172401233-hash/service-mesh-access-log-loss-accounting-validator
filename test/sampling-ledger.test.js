import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/ledger.js";
import { tick, resetClock, healthyChain, allSampledRules, findLoss } from "./helpers.js";

test("未被采样的入口不参与后续阶段对账，且不计为丢失", () => {
  resetClock();
  const events = [
    { type: "entry", at: tick(), seq: 1, requestId: "u1", attempt: 0, path: "/health", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "u1", attempt: 0, sampled: false, ruleId: "health-off" },
  ];
  const rules = {
    rules: [{ id: "health-off", pathPrefix: "/health", sampled: false }],
    default: { id: "d", sampled: true, percent: 100 },
  };
  const report = reconcile({ rules, events });
  assert.equal(report.summary.entryRequests, 1);
  assert.equal(report.summary.lost, 0);
  assert.equal(report.losses.length, 0);
  assert.equal(report.requests[0].attempts[0].expectedSampled, false);
});

test("采样不能隐藏非采样错误：应采样但缺 sample 事件判为 missing_sample_event", () => {
  resetClock();
  const events = [
    { type: "entry", at: tick(), seq: 1, requestId: "s1", attempt: 0, path: "/api", method: "GET", status: 200 },
  ];
  const report = reconcile({ rules: allSampledRules, events });
  const loss = findLoss(report, "missing_sample_event");
  assert.ok(loss, "应当报告采样事件缺失");
  assert.equal(loss.count, 1);
  assert.deepEqual(loss.entrySeqRanges, [{ from: 1, to: 1 }]);
  assert.equal(report.samplingMismatches[0].reason, "missing_sample_event");
});

test("应采样却被丢弃（undersampled）和不应采样却记录（oversampled）都报错", () => {
  resetClock();
  const rules = {
    rules: [
      { id: "api-on", pathPrefix: "/api", percent: 100 },
      { id: "health-off", pathPrefix: "/health", sampled: false },
    ],
    default: { sampled: false },
  };
  const events = [
    { type: "entry", at: tick(), seq: 1, requestId: "a", attempt: 0, path: "/api", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "a", attempt: 0, sampled: false, ruleId: "api-on" },
    { type: "entry", at: tick(), seq: 2, requestId: "b", attempt: 0, path: "/health", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "b", attempt: 0, sampled: true, ruleId: "health-off" },
    ...healthyChain("b", 2).slice(2),
  ];
  const report = reconcile({ rules, events });
  const reasons = report.samplingMismatches.map((item) => item.reason).sort();
  assert.deepEqual(reasons, ["oversampled", "undersampled"]);
});

test("健康完整链路不产生丢失或重复", () => {
  resetClock();
  const events = [...healthyChain("ok-1", 1), ...healthyChain("ok-2", 2)];
  const report = reconcile({ rules: allSampledRules, events });
  assert.equal(report.summary.entryRequests, 2);
  assert.equal(report.summary.completedSampled, 2);
  assert.equal(report.summary.lost, 0);
  assert.equal(report.duplicates.length, 0);
});

test("采样统计与入口、后端、计费数量同时给出，避免把差值当采样", () => {
  resetClock();
  const events = [
    ...healthyChain("ok-1", 1),
    { type: "entry", at: tick(), seq: 2, requestId: "u2", attempt: 0, path: "/health", method: "GET", status: 200 },
    { type: "sample", at: tick(), requestId: "u2", attempt: 0, sampled: false, ruleId: "off" },
  ];
  const rules = {
    rules: [
      { id: "off", pathPrefix: "/health", sampled: false },
      { id: "all", percent: 100 },
    ],
    default: { sampled: false },
  };
  const report = reconcile({ rules, events });
  assert.equal(report.summary.entryRequests, 2);
  assert.equal(report.summary.expectedSampled, 1);
  assert.equal(report.summary.observedSampled, 1);
  assert.equal(report.summary.completedSampled, 1);
});
