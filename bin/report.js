#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { reconcile } from "../src/ledger.js";
import { formatRanges } from "../src/range.js";

function printSummary(report) {
  const lines = [];
  lines.push("== 访问日志账本（全部基于本地事件） ==");
  const summary = report.summary;
  lines.push(`入口请求: ${summary.entryRequests}  期望采样: ${summary.expectedSampled}  实际采样: ${summary.observedSampled}`);
  lines.push(`采样完整链路: ${summary.completedSampled}  丢失: ${summary.lost}  重复日志行: ${summary.duplicateLogLines}`);
  lines.push(`采样错配: ${summary.samplingMismatches}  不可归因事件: ${summary.unattributableEvents}  不可归因请求: ${summary.unattributableRequests}  重启: ${summary.restarts}`);
  lines.push("");

  if (report.losses.length === 0) {
    lines.push("丢失区间: 无");
  } else {
    lines.push("丢失区间:");
    for (const loss of report.losses) {
      const rangeText = loss.entrySeqRanges.length ? formatRanges(loss.entrySeqRanges) : "(无入口序号)";
      lines.push(`  [${loss.stage}/${loss.reason}] ${loss.count} 条, 入口序号: ${rangeText}`);
    }
  }

  lines.push("");
  if (report.duplicates.length === 0) {
    lines.push("重复日志: 无");
  } else {
    lines.push("重复日志:");
    for (const dup of report.duplicates) {
      lines.push(
        `  ${dup.requestId}#${dup.attempt} sink=${dup.sink} 观测=${dup.observedCount} 重复=${dup.duplicateCount}` +
          (dup.logSeq.length ? ` 序号=${dup.logSeq.join(",")}` : ""),
      );
    }
  }

  lines.push("");
  lines.push(`不可归因请求: ${report.unattributableRequests.length}`);
  for (const item of report.unattributableRequests) {
    const attempts = item.attempts.map((entry) => `attempt ${entry.attempt}[${entry.observedStages.join("|")}]`).join("; ");
    lines.push(`  ${item.requestId}: ${item.reason} -> ${attempts}`);
  }

  console.log(lines.join("\n"));
}

async function main() {
  const args = process.argv.slice(2);
  const summaryOnly = args.includes("--summary");
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) {
    console.error("用法: log-ledger <events.json> [--summary]");
    process.exit(2);
  }
  const raw = await readFile(file, "utf8");
  const input = JSON.parse(raw);
  const report = reconcile(input);
  if (summaryOnly) {
    printSummary(report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
