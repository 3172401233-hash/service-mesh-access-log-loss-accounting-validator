import { test } from "node:test";
import assert from "node:assert/strict";
import { toRanges, formatRanges, rangeCount } from "../src/range.js";

test("toRanges 压缩连续序号并保留离散点", () => {
  assert.deepEqual(toRanges([1, 2, 3, 5, 6, 9]), [
    { from: 1, to: 3 },
    { from: 5, to: 6 },
    { from: 9, to: 9 },
  ]);
});

test("toRanges 去重、忽略非法值、容忍乱序", () => {
  assert.deepEqual(toRanges([4, 4, 2, 3, "x", null]), [{ from: 2, to: 4 }]);
  assert.deepEqual(toRanges([]), []);
});

test("formatRanges 与 rangeCount", () => {
  const ranges = toRanges([1, 2, 3, 7]);
  assert.equal(formatRanges(ranges), "1-3,7");
  assert.equal(rangeCount(ranges), 4);
  assert.equal(formatRanges([]), "");
});
