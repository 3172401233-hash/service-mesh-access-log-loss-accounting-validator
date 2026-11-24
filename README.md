# service-mesh-access-log-loss-accounting-validator

代理访问日志账本：在采样 + 异步写入 + 进程重启 + 重复发送 + 后端失败并存时，
重建入口请求到计费日志的完整链路，分阶段给出丢失区间、重复日志和不可归因请求。

运行环境：Node.js 24.16.0，零第三方依赖，ESM 实现。

## 本地事件约定

**本工具处理的所有日志都是本地事件**：它们只描述本进程观测到、写入到本地缓冲或
本地落盘的数据，不代表任何远程系统的真实状态，也不会向网络发起请求。

- 入口请求、采样决策、入缓冲、刷盘、重启、后端响应、后端日志、计费日志均为本地记录。
- 账本只对这些本地事件做对账，不假设“后端最终一致”或“丢失只是采样”。
- 采样规则仅用于判定入口请求**应不应该**进入日志链路；一旦判定应当采样，
  后续任何阶段缺事件都属于错误，采样不能用来解释或隐藏非采样丢失。

## 输入模型

输入为 `{ rules, events }`，事件按 `at`（再按 `seq`）排序后回放。

事件类型：

| type | 含义 | 关键字段 |
| --- | --- | --- |
| `entry` | 入口请求 | `requestId`、`attempt`、`seq`、`path`、`method`、`status` |
| `sample` | 本地采样决策 | `sampled`、`ruleId` |
| `enqueue` | 写入本地缓冲 | `seq` |
| `flush` | 缓冲刷入批次 | `batchId` |
| `restart` | 进程重启 | `restartId` |
| `response` | 后端响应（本地观测） | `status` |
| `backend_log` | 后端日志本地记录 | `seq` |
| `billing_log` | 计费日志本地记录 | `seq` |
| `duplicate_send` | 重复发送动作 | `sink`、`seq` |

同一请求的重试共享 `requestId`，以递增的 `attempt` 区分；账本保留 attempt 关系，
不同 attempt 的同 ID 日志不会互相算作重复。

采样规则按数组顺序匹配，首条命中生效，全部未命中走 `default`。
百分比采样使用确定性 FNV-1a 哈希（`hashKey(requestId) % 100`），重放结果稳定。

## 阶段与丢失代码

链路阶段：`entry → sampled → buffered → flushed → backend → billed`。

| 阶段 | reason | 含义 |
| --- | --- | --- |
| `sampled` | `missing_sample_event` | 应采样但没有采样事件 |
| `buffered` | `buffer_loss` | 采样后未进入写缓冲 |
| `buffered` | `unflushed_loss` | 已入缓冲但从未刷盘且无重启 |
| `flushed` | `restart_loss` | 重启时数据仍在缓冲区（携带 `restartIds`） |
| `flushed` | `inflight_loss` | 已刷盘但无响应、无后端日志 |
| `backend` | `backend_failure` | 后端响应 `status >= 500` |
| `backend` | `no_backend_log` | 后端成功但缺后端日志 |
| `billing` | `no_billing_log` | 有后端日志但缺计费日志 |

采样决策与规则不一致时单独输出 `samplingMismatches`：
`undersampled`（应采样却丢弃）、`oversampled`（不应采样却记录）、
`missing_sample_event`（无采样事件）。

重复日志按 `(requestId, attempt, sink)` 聚合，给出 `observedCount`、
`duplicateCount`、本地日志序号以及关联的 `duplicate_send` 序号。

不可归因输出分两类：

- `unattributable`：缺少 `requestId` 或类型未知的原始事件。
- `unattributableRequests`：只有下游日志、没有入口事件的请求
  （`downstream_log_without_entry`），它们不会进入阶段丢失桶。

## 输出

- `summary`：入口数、期望/实际采样数、完整链路数、丢失数、重复行数、不可归因数。
- `losses`：按阶段+原因分组，`entrySeqRanges` 为压缩后的入口序号闭区间
  （如 `2-3,7`），并附每个请求的明细。
- `duplicates`：重复日志明细。
- `samplingMismatches`：采样错配明细。
- `unattributable` / `unattributableRequests`：不可归因事件与请求。
- `requests`：每个请求的 attempt 列表、到达阶段、计数、重启 ID、重试关系。

## 使用

```bash
node --test
node bin/report.js examples/scenario.json            # 完整 JSON 账本
node bin/report.js examples/scenario.json --summary  # 人类可读摘要
npm run demo
```

程序化调用：

```js
import { reconcile } from "./src/ledger.js";
import { readFileSync } from "node:fs";

const report = reconcile(JSON.parse(readFileSync("events.json", "utf8")));
console.log(report.losses, report.duplicates, report.unattributableRequests);
```

## 目录结构

```
src/range.js      序号区间压缩与渲染
src/sampling.js   规则匹配与确定性哈希采样
src/ledger.js     事件回放、状态机重建与分阶段对账
bin/report.js     CLI（JSON / 摘要两种输出）
examples/         混合场景示例
test/             node:test 测试（采样、重启、重复、后端失败、CLI）
```
