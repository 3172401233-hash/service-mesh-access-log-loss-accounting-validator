import { expectedDecision } from "./sampling.js";
import { toRanges } from "./range.js";

/**
 * 阶段顺序，用于判断每个 attempt 实际推进到的最远阶段。
 */
const STAGE_RANK = {
  entry: 0,
  sampled: 1,
  buffered: 2,
  flushed: 3,
  backend: 4,
  billed: 5,
};

const LOSS_GROUPS = [
  ["buffered", "buffer_loss"],
  ["buffered", "unflushed_loss"],
  ["flushed", "restart_loss"],
  ["flushed", "inflight_loss"],
  ["backend", "backend_failure"],
  ["backend", "no_backend_log"],
  ["billing", "no_billing_log"],
  ["sampled", "missing_sample_event"],
];

function ensureAttempt(index, event) {
  const attempt = event.attempt ?? 0;
  let request = index.requests.get(event.requestId);
  if (!request) {
    request = {
      requestId: event.requestId,
      attempts: new Map(),
      entrySeq: null,
    };
    index.requests.set(event.requestId, request);
  }
  let record = request.attempts.get(attempt);
  if (!record) {
    record = {
      requestId: event.requestId,
      attempt,
      stages: new Set(),
      entry: null,
      sample: null,
      enqueues: [],
      flushes: [],
      responses: [],
      backendLogs: [],
      billingLogs: [],
      restartIds: [],
      duplicateSends: [],
      maxRank: STAGE_RANK.entry,
    };
    request.attempts.set(attempt, record);
  }
  return { request, record };
}

function reach(record, stage) {
  record.stages.add(stage);
  record.maxRank = Math.max(record.maxRank, STAGE_RANK[stage] ?? 0);
}

function buildIndex(events) {
  const index = {
    requests: new Map(),
    restarts: [],
    unattributable: [],
  };

  const ordered = [...events].sort((a, b) => {
    if (a.at !== b.at) {
      return a.at < b.at ? -1 : 1;
    }
    return (a.seq ?? 0) - (b.seq ?? 0);
  });

  for (const event of ordered) {
    if (event.type === "restart") {
      index.restarts.push({ id: event.restartId ?? `restart-${index.restarts.length + 1}`, at: event.at });
      continue;
    }

    if (!event.requestId) {
      index.unattributable.push({ event, reason: "missing_request_id" });
      continue;
    }

    const { request, record } = ensureAttempt(index, event);

    switch (event.type) {
      case "entry":
        record.entry = event;
        if (request.entrySeq === null && Number.isSafeInteger(event.seq)) {
          request.entrySeq = event.seq;
        }
        reach(record, "entry");
        break;
      case "sample":
        record.sample = event;
        if (event.sampled) {
          reach(record, "sampled");
        }
        break;
      case "enqueue":
        record.enqueues.push(event);
        reach(record, "buffered");
        break;
      case "flush":
        record.flushes.push(event);
        reach(record, "flushed");
        break;
      case "response":
        record.responses.push(event);
        if ((event.status ?? 200) < 500) {
          reach(record, "backend");
        }
        break;
      case "backend_log":
        record.backendLogs.push(event);
        reach(record, "backend");
        break;
      case "billing_log":
        record.billingLogs.push(event);
        reach(record, "billed");
        break;
      case "duplicate_send":
        record.duplicateSends.push(event);
        break;
      default:
        index.unattributable.push({ event, reason: "unknown_event_type" });
    }
  }

  return index;
}

/**
 * 重启事件会让仍停留在 buffered 阶段的 attempt 丢失缓冲数据。
 * 只有在该 attempt 之后从未成功推进到 flushed/backend/billed 时才判定为重启丢失，
 * 这样重启后的重试不会被误报。
 */
function attachRestarts(index) {
  for (const request of index.requests.values()) {
    for (const record of request.attempts.values()) {
      if (record.enqueues.length === 0) {
        continue;
      }
      const lastEnqueueAt = record.enqueues[record.enqueues.length - 1].at;
      const firstFlushAt = record.flushes.length ? record.flushes[0].at : null;
      for (const restart of index.restarts) {
        const afterEnqueue = restart.at > lastEnqueueAt;
        const beforeFlush = firstFlushAt === null || restart.at < firstFlushAt;
        if (afterEnqueue && beforeFlush && record.maxRank < STAGE_RANK.flushed) {
          record.restartIds.push(restart.id);
        }
      }
    }
  }
}

function classifySampled(record) {
  if (record.restartIds.length > 0) {
    return { stage: "flushed", reason: "restart_loss", detail: { restartIds: record.restartIds } };
  }
  if (!record.stages.has("buffered")) {
    return { stage: "buffered", reason: "buffer_loss" };
  }
  if (!record.stages.has("flushed")) {
    return { stage: "buffered", reason: "unflushed_loss" };
  }

  const failedResponse = record.responses.find((response) => (response.status ?? 0) >= 500);
  if (failedResponse) {
    return {
      stage: "backend",
      reason: "backend_failure",
      detail: { status: failedResponse.status, responseAt: failedResponse.at },
    };
  }
  if (!record.stages.has("backend")) {
    return { stage: "flushed", reason: "inflight_loss" };
  }
  if (record.backendLogs.length === 0) {
    return { stage: "backend", reason: "no_backend_log" };
  }
  if (record.billingLogs.length === 0) {
    return { stage: "billing", reason: "no_billing_log" };
  }
  return null;
}

function checkSampling(record, expected) {
  const observed = record.sample?.sampled;
  if (observed === undefined) {
    return {
      mismatch: true,
      reason: "missing_sample_event",
      expected: expected.sampled,
      observed: null,
      ruleId: expected.ruleId,
    };
  }
  if (observed !== expected.sampled) {
    return {
      mismatch: true,
      reason: expected.sampled ? "undersampled" : "oversampled",
      expected: expected.sampled,
      observed,
      ruleId: expected.ruleId,
    };
  }
  return { mismatch: false, reason: null, expected: expected.sampled, observed, ruleId: expected.ruleId };
}

function buildDuplicates(record) {
  const sinks = [
    { sink: "buffer", logs: record.enqueues },
    { sink: "buffer", logs: record.flushes },
    { sink: "backend", logs: record.backendLogs },
    { sink: "billing", logs: record.billingLogs },
  ];

  const duplicates = [];
  for (const { sink, logs } of sinks) {
    if (logs.length <= 1) {
      continue;
    }
    const sendEvents = record.duplicateSends.filter((event) => (event.sink ?? "backend") === sink);
    duplicates.push({
      requestId: record.requestId,
      attempt: record.attempt,
      sink,
      observedCount: logs.length,
      duplicateCount: logs.length - 1,
      logSeq: logs.map((event) => event.seq).filter(Number.isSafeInteger),
      duplicateSendSeq: sendEvents.map((event) => event.seq).filter(Number.isSafeInteger),
      at: logs.map((event) => event.at),
    });
  }
  return duplicates;
}

/**
 * 主入口：输入 { rules, events }，输出完整账本。
 * 所有输入都表示本地观测到的事件，不包含任何远程系统的真实状态假设。
 */
export function reconcile(input) {
  const rules = input.rules ?? { rules: [], default: { sampled: false } };
  const index = buildIndex(input.events ?? []);
  attachRestarts(index);

  const lossBuckets = new Map();
  const samplingMismatches = [];
  const duplicates = [];
  const requestLedger = [];
  const unattributableRequests = [];

  const addLoss = (stage, reason, record, detail = {}) => {
    const key = `${stage}:${reason}`;
    if (!lossBuckets.has(key)) {
      lossBuckets.set(key, { stage, reason, entrySeq: [], requests: [] });
    }
    const bucket = lossBuckets.get(key);
    const request = index.requests.get(record.requestId);
    if (request.entrySeq !== null) {
      bucket.entrySeq.push(request.entrySeq);
    }
    bucket.requests.push({
      requestId: record.requestId,
      attempt: record.attempt,
      entrySeq: request.entrySeq,
      ...detail,
    });
  };

  let totalEntry = 0;
  let expectedSampled = 0;
  let observedSampled = 0;
  let complete = 0;

  for (const request of index.requests.values()) {
    const attemptEntries = [];
    const sortedAttempts = [...request.attempts.values()].sort((a, b) => a.attempt - b.attempt);

    const attemptsWithoutEntry = sortedAttempts.filter((record) => record.entry === null);
    if (attemptsWithoutEntry.length > 0) {
      unattributableRequests.push({
        reason: "downstream_log_without_entry",
        requestId: request.requestId,
        attempts: attemptsWithoutEntry.map((record) => ({
          attempt: record.attempt,
          observedStages: [...record.stages],
          backendLogs: record.backendLogs.length,
          billingLogs: record.billingLogs.length,
        })),
      });
    }

    for (const record of sortedAttempts) {
      if (record.entry) {
        totalEntry += 1;
      }
      const baseEvent = record.entry ?? record.sample ?? record.enqueues[0] ?? record.backendLogs[0] ?? record.billingLogs[0];
      const expected = expectedDecision(rules, baseEvent ?? { requestId: record.requestId, path: "/", method: "GET" });
      const sampling = checkSampling(record, expected);

      if (expected.sampled) {
        expectedSampled += 1;
      }
      if (record.stages.has("sampled")) {
        observedSampled += 1;
      }

      let loss = null;
      if (record.entry === null) {
        loss = { stage: "unattributable", reason: "downstream_log_without_entry", detail: null };
      } else {
        if (sampling.mismatch) {
          samplingMismatches.push({
            requestId: record.requestId,
            attempt: record.attempt,
            entrySeq: request.entrySeq,
            ...sampling,
          });
          if (sampling.reason === "missing_sample_event" && expected.sampled) {
            addLoss("sampled", "missing_sample_event", record, { expectedRuleId: expected.ruleId });
          }
        }

        if (expected.sampled) {
          loss = classifySampled(record);
          if (loss) {
            addLoss(loss.stage, loss.reason, record, loss.detail ?? {});
          } else {
            complete += 1;
          }
        }
      }

      duplicates.push(...buildDuplicates(record));

      attemptEntries.push({
        attempt: record.attempt,
        expectedSampled: expected.sampled,
        observedSampled: record.sample?.sampled ?? null,
        ruleId: expected.ruleId,
        stagesReached: [...record.stages],
        lost: loss
          ? { stage: loss.stage, reason: loss.reason, detail: loss.detail ?? null }
          : null,
        counts: {
          enqueue: record.enqueues.length,
          flush: record.flushes.length,
          backendLog: record.backendLogs.length,
          billingLog: record.billingLogs.length,
          response: record.responses.length,
          duplicateSend: record.duplicateSends.length,
        },
        restartIds: record.restartIds,
      });
    }

    requestLedger.push({
      requestId: request.requestId,
      entrySeq: request.entrySeq,
      attempts: attemptEntries,
      retryOf: sortedAttempts
        .filter((record) => record.attempt > 0)
        .map((record) => record.attempt),
    });
  }

  const losses = LOSS_GROUPS.filter(([stage, reason]) => lossBuckets.has(`${stage}:${reason}`))
    .map(([stage, reason]) => {
      const bucket = lossBuckets.get(`${stage}:${reason}`);
      const ranges = toRanges(bucket.entrySeq);
      return {
        stage,
        reason,
        count: bucket.requests.length,
        entrySeqRanges: ranges,
        entrySeqRangeText: ranges.length ? ranges.map((r) => (r.from === r.to ? r.from : `${r.from}-${r.to}`)).join(",") : null,
        requests: bucket.requests,
      };
    });

  const totalLost = losses.reduce((sum, bucket) => sum + bucket.count, 0);
  const totalDuplicateLogs = duplicates.reduce((sum, item) => sum + item.duplicateCount, 0);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      entryRequests: totalEntry,
      expectedSampled,
      observedSampled,
      completedSampled: complete,
      lost: totalLost,
      duplicateLogRecords: duplicates.length,
      duplicateLogLines: totalDuplicateLogs,
      unattributableEvents: index.unattributable.length,
      unattributableRequests: unattributableRequests.length,
      samplingMismatches: samplingMismatches.length,
      restarts: index.restarts.length,
    },
    losses,
    duplicates,
    samplingMismatches,
    unattributable: index.unattributable.map(({ event, reason }) => ({ reason, event })),
    unattributableRequests,
    restarts: index.restarts,
    requests: requestLedger,
  };
}
