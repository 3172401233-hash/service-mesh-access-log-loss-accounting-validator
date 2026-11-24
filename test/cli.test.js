import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "bin", "report.js");
const scenario = join(here, "..", "examples", "scenario.json");

test("CLI --summary 输出重启丢失、重复日志和不可归因请求", async () => {
  const { stdout } = await exec(process.execPath, [cli, scenario, "--summary"]);
  assert.match(stdout, /restart_loss/);
  assert.match(stdout, /backend_failure/);
  assert.match(stdout, /req-dup#0 sink=backend/);
  assert.match(stdout, /req-ghost: downstream_log_without_entry/);
  assert.match(stdout, /全部基于本地事件/);
});

test("CLI 默认输出 JSON 账本", async () => {
  const { stdout } = await exec(process.execPath, [cli, scenario]);
  const report = JSON.parse(stdout);
  assert.equal(report.summary.restarts, 1);
  assert.equal(report.summary.duplicateLogLines, 1);
  assert.equal(report.unattributableRequests.length, 1);
  assert.ok(Array.isArray(report.losses));
});

test("CLI 缺少文件参数时退出码为 2", async () => {
  await assert.rejects(
    () => exec(process.execPath, [cli]),
    (error) => error.code === 2,
  );
});
