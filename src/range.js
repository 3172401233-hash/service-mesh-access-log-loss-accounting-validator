/**
 * 把一组单调或无序的整数序号压缩成闭区间列表。
 * [1,2,3,5,6,9] => [{from:1,to:1},{from:2,to:3},{from:5,to:6},{from:9,to:9}]
 * 单元素区间也保留 from/to，方便调用方统一渲染。
 */
export function toRanges(numbers) {
  const sorted = [...new Set(numbers)]
    .filter((value) => Number.isSafeInteger(value))
    .sort((a, b) => a - b);

  const ranges = [];
  for (const value of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && value === last.to + 1) {
      last.to = value;
    } else {
      ranges.push({ from: value, to: value });
    }
  }
  return ranges;
}

/**
 * 区间渲染：单元素显示 "7"，连续区间显示 "3-6"。
 */
export function formatRanges(ranges) {
  return ranges
    .map((range) => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`))
    .join(",");
}

/**
 * 计算一个闭区间集合覆盖的整数个数。
 */
export function rangeCount(ranges) {
  return ranges.reduce((sum, range) => sum + (range.to - range.from + 1), 0);
}
