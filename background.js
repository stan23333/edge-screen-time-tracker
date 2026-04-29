importScripts("utils/time.js", "utils/url.js", "utils/storage.js");

const IDLE_THRESHOLD_SECONDS = 300;
const CHECKPOINT_ALARM = "checkpoint-active-session";
const SUSPEND_GAP_MS = 10 * 60 * 1000;
const SCREENSHOT_FALLBACK_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000;
const MODEL_REQUEST_TIMEOUT_MS = 15 * 1000;
const ANALYSIS_MODEL_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_SUMMARY_TEXT_CHARS = 200;
const MAX_DIAGNOSTIC_LOGS = 1000;
const LOCAL_ARCHIVE_DB = "web-screen-time-tracker-local-archive";
const LOCAL_ARCHIVE_STORE = "handles";
const LOCAL_ARCHIVE_HANDLE_KEY = "directory";
const IGNORE_DOMAIN_MENU = "ignore-current-website";
const METRICS = {
  ACTIVE: "activeSeconds",
  OPEN: "openSeconds"
};
const SUMMARY_STATUS = {
  NONE: "none",
  PENDING: "pending",
  CAPTURING: "capturing",
  SUMMARIZING: "summarizing",
  DONE: "done",
  ERROR: "error",
  SKIPPED: "skipped"
};
const CAPTURE_METHOD = {
  DOM_TEXT: "dom_text",
  METADATA_ONLY: "metadata_only",
  SCREENSHOT_VISION: "screenshot_vision"
};
const CAPTURE_STATUS = {
  OK: "ok",
  LOW_CONTENT: "low_content",
  BLOCKED: "blocked",
  WAITING_VISIBLE_TAB: "waiting_visible_tab",
  SCREENSHOT_ATTEMPTING: "screenshot_attempting",
  UNSUPPORTED: "unsupported",
  ERROR: "error"
};
const EVIDENCE_LEVEL = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low"
};
const LOG_RESPONSE_EXCERPT_CHARS = 500;
const LOG_TEXT_CHARS = 1000;
const LOG_DETAILS_DEPTH = 4;
const LOG_ARRAY_ITEMS = 25;
let operationQueue = Promise.resolve();
let summaryQueue = Promise.resolve();
let diagnosticLogQueue = Promise.resolve();
let autoBackupRunning = false;
const pendingSummaryVisitIds = new Set();
let lastSummaryStatus = {
  at: 0,
  status: "none",
  reason: "No summary task has run yet."
};
let lastAnalysisStatus = {
  at: 0,
  status: "none",
  reason: "No analysis task has run yet."
};

function redactSensitiveText(value, limit = LOG_TEXT_CHARS) {
  return String(value ?? "")
    .replace(/(api[_-]?key|token|password|secret|authorization)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=-]+/gi, "Basic [redacted]")
    .slice(0, limit);
}

function sanitizeUrlForLog(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  try {
    const url = new URL(text);
    const search = url.search ? "?[redacted]" : "";
    const hash = url.hash ? "#[redacted]" : "";
    return `${url.origin}${url.pathname}${search}${hash}`;
  } catch {
    return redactSensitiveText(text, LOG_TEXT_CHARS);
  }
}

function sanitizeMessageForLog(value, limit = LOG_TEXT_CHARS) {
  return redactSensitiveText(value, limit).replace(/https?:\/\/[^\s)]+/gi, (match) => sanitizeUrlForLog(match));
}

function isSensitiveLogKey(key) {
  return /^(apiKey|authorization|password|secret|prompt|content|body|messages|payload|imageDataUrl|dataUrl|pageText|rawText|capturedText|text)$/i.test(String(key || ""));
}

function sanitizeDiagnosticDetails(value, depth = 0, key = "") {
  if (value === null || value === undefined) {
    return value;
  }

  if (isSensitiveLogKey(key)) {
    return "[redacted]";
  }

  if (typeof value === "string") {
    if (/^data:image\//i.test(value)) {
      return "[redacted image data]";
    }
    if (/(^url$|url$|endpoint|baseUrl|testUrl|remoteUrl)/i.test(String(key || ""))) {
      return sanitizeUrlForLog(value);
    }
    return redactSensitiveText(value, key === "responseTextExcerpt" ? LOG_RESPONSE_EXCERPT_CHARS : LOG_TEXT_CHARS);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (depth >= LOG_DETAILS_DEPTH) {
    return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, LOG_ARRAY_ITEMS).map((item) => sanitizeDiagnosticDetails(item, depth + 1));
  }

  if (typeof value === "object") {
    const result = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (typeof entryValue === "function" || entryValue === undefined) {
        continue;
      }
      result[entryKey] = sanitizeDiagnosticDetails(entryValue, depth + 1, entryKey);
    }
    return result;
  }

  return redactSensitiveText(value);
}

function normalizeErrorForLog(error) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: sanitizeMessageForLog(error.message || "Operation failed."),
      stack: error.stack ? sanitizeMessageForLog(error.stack, 2000) : "",
      status: error.status || null,
      diagnostic: sanitizeDiagnosticDetails(error.diagnostic || null)
    };
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: sanitizeMessageForLog(error)
    };
  }

  return sanitizeDiagnosticDetails(error);
}

function sanitizeLogEntry(entry = {}) {
  const error = normalizeErrorForLog(entry.error);
  const message = entry.message || error?.message || "Operation logged.";
  const log = {
    ...entry,
    level: entry.level || "info",
    priority: entry.priority || "low",
    source: entry.source || "background",
    category: entry.category || "program",
    operation: entry.operation || "unknown",
    message: sanitizeMessageForLog(message, LOG_TEXT_CHARS),
    details: sanitizeDiagnosticDetails(entry.details),
    error
  };

  if (entry.url) {
    log.url = sanitizeUrlForLog(entry.url);
  }
  if (entry.endpoint) {
    log.endpoint = sanitizeUrlForLog(entry.endpoint);
  }
  if (entry.domain) {
    log.domain = redactSensitiveText(entry.domain, 300);
  }
  if (entry.model) {
    log.model = redactSensitiveText(entry.model, 300);
  }
  if (entry.provider) {
    log.provider = redactSensitiveText(entry.provider, 300);
  }
  if (entry.status === undefined && error?.status) {
    log.status = error.status;
  }

  return log;
}

async function addDiagnosticLog(entry) {
  const task = () => StorageUtils.addDiagnosticLog(sanitizeLogEntry(entry));
  const next = diagnosticLogQueue.then(task, task);
  diagnosticLogQueue = next.catch(() => null);
  try {
    return await next;
  } catch (error) {
    console.error("Failed to write diagnostic log", error);
    return null;
  }
}

function modelLogFields(config = {}) {
  const endpoint = config.endpoint || buildChatCompletionsEndpoint(config.baseUrl || "");
  return {
    provider: config.provider || "custom",
    model: config.model || "",
    endpoint: endpoint || config.baseUrl || ""
  };
}

function modelRequestDiagnostic(config, endpoint, body, timeoutMs, extra = {}) {
  return {
    provider: config?.provider || "custom",
    model: config?.model || "",
    endpoint: sanitizeUrlForLog(endpoint),
    method: "POST",
    timeoutMs,
    jsonMode: Boolean(body?.response_format),
    maxTokens: body?.max_tokens || null,
    fastMode: Boolean(body?.enable_thinking === false),
    ...extra
  };
}

function attachDiagnostic(error, diagnostic) {
  error.diagnostic = {
    ...(error.diagnostic || {}),
    ...diagnostic
  };
  return error;
}

function errorCategory(error, fallback = "program") {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("required") || [400, 401, 403].includes(error?.status)) {
    return "configuration";
  }
  if (message.includes("model request") || error?.status || error?.diagnostic?.endpoint) {
    return "external";
  }
  return fallback;
}

function errorPriority(error, fallback = "medium") {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("required") || [400, 401, 403].includes(error?.status)) {
    return "high";
  }
  return fallback;
}

function setLastAnalysisStatus(status, reason, details = {}) {
  lastAnalysisStatus = {
    at: Date.now(),
    status,
    reason,
    ...details
  };
}

function normalizeIgnoredDomains(domains) {
  return [...new Set((domains || [])
    .map((domain) => String(domain).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].trim().toLowerCase())
    .filter(Boolean))]
    .sort();
}

async function isIgnoredIdentity(identity) {
  if (!identity?.domain) {
    return false;
  }

  const settings = await StorageUtils.getSettings();
  return normalizeIgnoredDomains(settings.ignoredDomains).includes(identity.domain);
}

function isIgnoredPageSession(tab, state) {
  if (!Number.isInteger(tab?.id) || !tab.url) {
    return false;
  }

  return state.ignoredPageSessions?.[String(tab.id)] === tab.url;
}

async function ignoreDomain(domain) {
  const settings = await StorageUtils.getSettings();
  settings.ignoredDomains = normalizeIgnoredDomains([...(settings.ignoredDomains || []), domain]);
  await StorageUtils.setSettings(settings);
  return settings.ignoredDomains;
}

async function ignoreDomainAndSettle(domain, tabId = null) {
  const ignoredDomains = await ignoreDomain(domain);

  if (Number.isInteger(tabId)) {
    await settleOpenSession(tabId);
    const state = await StorageUtils.getState();
    if (state.activeSession?.tabId === tabId) {
      await settleActiveSession();
      await StorageUtils.set({ activeSession: null });
    }
  }

  return ignoredDomains;
}

async function ignoreCurrentVisit(tab) {
  const identity = UrlUtils.getPageIdentity(tab?.url);
  if (!identity || !Number.isInteger(tab.id)) {
    throw new Error("Only normal http/https pages can be ignored.");
  }

  const state = await StorageUtils.getState();
  const ignoredPageSessions = {
    ...(state.ignoredPageSessions || {}),
    [String(tab.id)]: identity.url
  };

  await settleOpenSession(tab.id);
  const latestState = await StorageUtils.getState();
  if (latestState.activeSession?.tabId === tab.id) {
    await settleActiveSession();
  }

  await StorageUtils.set({
    activeSession: latestState.activeSession?.tabId === tab.id ? null : latestState.activeSession,
    ignoredPageSessions
  });

  return {
    domain: identity.domain,
    url: identity.url
  };
}

async function setupContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: IGNORE_DOMAIN_MENU,
    title: "Ignore this website",
    contexts: ["page"],
    documentUrlPatterns: ["http://*/*", "https://*/*"]
  });
}

function enqueueOperation(task) {
  const wrappedTask = async () => {
    await reconcileSuspendedHeartbeat();
    try {
      return await task();
    } finally {
      await touchHeartbeat();
    }
  };
  const next = operationQueue.then(wrappedTask, wrappedTask);
  operationQueue = next.catch(async (error) => {
    console.error("Tracker operation failed", error);
    await addDiagnosticLog({
      level: "error",
      priority: "high",
      source: "runtime",
      category: "program",
      operation: "tracker_operation_queue",
      message: error.message || "Tracker operation failed.",
      error
    });
  });
  return next;
}

function enqueueSummaryOperation(task) {
  const next = summaryQueue.then(task, task);
  summaryQueue = next.catch(async (error) => {
    console.error("Summary operation failed", error);
    await addDiagnosticLog({
      level: "error",
      priority: "high",
      source: "runtime",
      category: "program",
      operation: "summary_operation_queue",
      message: error.message || "Summary operation failed.",
      error
    });
  });
  return next;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function setLastSummaryStatus(status, reason, extra = {}) {
  lastSummaryStatus = {
    at: Date.now(),
    status,
    reason,
    ...extra
  };
}

async function getFocusedActiveTab(windowId) {
  if (!Number.isInteger(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) {
    return null;
  }

  const tabs = await chrome.tabs.query({ active: true, windowId });
  return tabs[0] || null;
}

async function getLastFocusedWindowId() {
  try {
    const window = await chrome.windows.getLastFocused({ populate: false });
    return window?.focused ? window.id : chrome.windows.WINDOW_ID_NONE;
  } catch {
    return chrome.windows.WINDOW_ID_NONE;
  }
}

function normalizeStatsEntry(value) {
  if (typeof value === "number") {
    return {
      activeSeconds: value,
      openSeconds: 0
    };
  }

  return {
    activeSeconds: Math.max(0, Math.floor(value?.activeSeconds || 0)),
    openSeconds: Math.max(0, Math.floor(value?.openSeconds || 0))
  };
}

function addDuration(dailyStats, domain, startTs, endTs, metric) {
  let cursor = startTs;

  while (cursor < endTs) {
    const key = TimeUtils.dateKeyFromTimestamp(cursor);
    const nextBoundary = TimeUtils.startOfNextDay(cursor);
    const segmentEnd = Math.min(endTs, nextBoundary);
    const seconds = Math.floor((segmentEnd - cursor) / 1000);

    if (seconds > 0) {
      dailyStats[key] = dailyStats[key] || {};
      dailyStats[key][domain] = normalizeStatsEntry(dailyStats[key][domain]);
      dailyStats[key][domain][metric] += seconds;
    }

    cursor = segmentEnd;
  }
}

function splitIntervalByDay(startTs, endTs) {
  const intervals = [];
  let cursor = Math.max(0, Math.floor(startTs || 0));
  const end = Math.max(cursor, Math.floor(endTs || 0));

  while (cursor < end) {
    const dateKey = TimeUtils.dateKeyFromTimestamp(cursor);
    const segmentEnd = Math.min(end, TimeUtils.startOfNextDay(cursor));
    if (segmentEnd > cursor) {
      intervals.push({ dateKey, start: cursor, end: segmentEnd });
    }
    cursor = segmentEnd;
  }

  return intervals;
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
}

function secondsFromIntervals(intervals) {
  return mergeIntervals(intervals).reduce((sum, interval) => sum + Math.floor((interval.end - interval.start) / 1000), 0);
}

function addInterval(bucket, dateKey, domain, interval) {
  bucket[dateKey] = bucket[dateKey] || {};
  bucket[dateKey][domain] = bucket[dateKey][domain] || [];
  bucket[dateKey][domain].push(interval);
}

function rebuildDailyStatsFromVisits(visitEvents, liveVisitIds = new Set(), now = Date.now()) {
  const openIntervals = {};
  const activeIntervals = {};

  for (const dayEvents of Object.values(visitEvents || {})) {
    for (const event of dayEvents || []) {
      if (!event?.domain || !event.openedAt) {
        continue;
      }

      const openEnd = event.closedAt
        || (liveVisitIds.has(event.id) ? now : (event.openSeconds ? event.openedAt + event.openSeconds * 1000 : null));
      if (openEnd) {
        for (const interval of splitIntervalByDay(event.openedAt, openEnd)) {
          addInterval(openIntervals, interval.dateKey, event.domain, interval);
        }
      }

      const activeSource = Array.isArray(event.activeIntervals) && event.activeIntervals.length
        ? event.activeIntervals
        : event.activeSeconds
          ? [{ start: event.openedAt, end: event.openedAt + event.activeSeconds * 1000 }]
          : [];

      for (const activeInterval of activeSource) {
        for (const interval of splitIntervalByDay(activeInterval.start, activeInterval.end)) {
          addInterval(activeIntervals, interval.dateKey, event.domain, interval);
        }
      }
    }
  }

  const dailyStats = {};
  const dateKeys = new Set([...Object.keys(openIntervals), ...Object.keys(activeIntervals)]);
  for (const dateKey of dateKeys) {
    dailyStats[dateKey] = {};
    const domains = new Set([
      ...Object.keys(openIntervals[dateKey] || {}),
      ...Object.keys(activeIntervals[dateKey] || {})
    ]);
    for (const domain of domains) {
      const activeSeconds = secondsFromIntervals(activeIntervals[dateKey]?.[domain] || []);
      const openSeconds = Math.max(secondsFromIntervals(openIntervals[dateKey]?.[domain] || []), activeSeconds);
      dailyStats[dateKey][domain] = { activeSeconds, openSeconds };
    }
  }

  return dailyStats;
}

async function rebuildAndStoreDailyStats() {
  const state = await StorageUtils.getState();
  const visitEvents = await StorageUtils.getVisitEvents();
  const liveVisitIds = liveVisitIdsFromState(state);
  const repaired = repairOrphanOpenVisitEvents(visitEvents, liveVisitIds);
  if (repaired) {
    await StorageUtils.setVisitEvents(visitEvents);
  }
  const dailyStats = rebuildDailyStatsFromVisits(visitEvents, liveVisitIds);
  await StorageUtils.setDailyStats(dailyStats);
  return dailyStats;
}

function enforceOpenCoversActive(dailyStats, dateKey = null, domain = null) {
  const dateKeys = dateKey ? [dateKey] : Object.keys(dailyStats || {});
  let changed = false;

  for (const key of dateKeys) {
    const day = dailyStats[key];
    if (!day) {
      continue;
    }

    const domains = domain ? [domain] : Object.keys(day);
    for (const currentDomain of domains) {
      if (!day[currentDomain]) {
        continue;
      }

      const previous = day[currentDomain];
      const entry = normalizeStatsEntry(previous);
      const nextOpenSeconds = Math.max(entry.openSeconds, entry.activeSeconds);
      const needsObjectShape = typeof previous === "number";
      if (entry.openSeconds !== nextOpenSeconds || needsObjectShape) {
        entry.openSeconds = nextOpenSeconds;
        day[currentDomain] = entry;
        changed = true;
      }
    }
  }

  return changed;
}

function createOpenSession(tab, identity, startTs = Date.now()) {
  return {
    visitId: crypto.randomUUID(),
    domain: identity.domain,
    url: identity.url,
    title: tab.title || identity.domain,
    tabId: tab.id,
    windowId: tab.windowId,
    startTs,
    lastSavedTs: startTs
  };
}

function visitDateKey(session) {
  return TimeUtils.dateKeyFromTimestamp(session.openedAt || session.startTs || Date.now());
}

function addVisitEventToStore(visitEvents, session) {
  const key = visitDateKey(session);
  visitEvents[key] = visitEvents[key] || [];
  visitEvents[key].push({
    id: session.visitId,
    domain: session.domain,
    url: session.url,
    title: session.title,
    tabId: session.tabId,
    windowId: session.windowId,
    openedAt: session.startTs,
    closedAt: null,
    openSeconds: 0,
    activeSeconds: 0,
    activeIntervals: [],
    summaryId: null,
    summaryStatus: SUMMARY_STATUS.NONE
  });
}

function updateVisitEventInStore(visitEvents, visitId, updater) {
  if (!visitId) {
    return false;
  }

  for (const dayEvents of Object.values(visitEvents || {})) {
    const event = dayEvents.find((item) => item.id === visitId);
    if (event) {
      updater(event);
      return true;
    }
  }

  return false;
}

function finishVisitEventInStore(visitEvents, session, endTs) {
  updateVisitEventInStore(visitEvents, session.visitId, (event) => {
    event.closedAt = endTs;
    event.openSeconds = Math.max(event.openSeconds || 0, Math.floor((endTs - event.openedAt) / 1000));
    event.title = session.title || event.title;
  });
}

function checkpointVisitEventInStore(visitEvents, session, endTs) {
  updateVisitEventInStore(visitEvents, session.visitId, (event) => {
    event.openSeconds = Math.max(event.openSeconds || 0, Math.floor((endTs - event.openedAt) / 1000));
    event.title = session.title || event.title;
  });
}

function addActiveIntervalToStore(visitEvents, session, endTs) {
  updateVisitEventInStore(visitEvents, session.visitId, (event) => {
    const seconds = Math.max(0, Math.floor((endTs - session.startTs) / 1000));
    if (seconds <= 0) {
      return;
    }

    event.activeIntervals = event.activeIntervals || [];
    event.activeIntervals.push({
      start: session.startTs,
      end: endTs,
      seconds
    });
    event.activeSeconds = Math.max(0, Math.floor(event.activeSeconds || 0)) + seconds;
  });
}

function liveVisitIdsFromState(state) {
  const ids = new Set();
  for (const session of Object.values(state?.openSessions || {})) {
    if (session?.visitId) {
      ids.add(session.visitId);
    }
  }
  if (state?.activeSession?.visitId) {
    ids.add(state.activeSession.visitId);
  }
  return ids;
}

function bestEffortVisitCloseTs(event, fallbackTs = null) {
  const openedAt = Math.max(0, Math.floor(event?.openedAt || 0));
  const fallback = Math.max(0, Math.floor(fallbackTs || 0));
  const savedOpenEnd = event?.openSeconds
    ? openedAt + Math.max(0, Math.floor(event.openSeconds)) * 1000
    : 0;
  return Math.max(openedAt, fallback, savedOpenEnd || openedAt);
}

function repairOrphanOpenVisitEvents(visitEvents, liveVisitIds, fallbackTsByVisitId = {}) {
  let changed = false;

  for (const dayEvents of Object.values(visitEvents || {})) {
    for (const event of dayEvents || []) {
      if (!event?.id || event.closedAt || liveVisitIds.has(event.id)) {
        continue;
      }

      const closeTs = bestEffortVisitCloseTs(event, fallbackTsByVisitId[event.id]);
      event.closedAt = closeTs;
      event.openSeconds = Math.max(event.openSeconds || 0, Math.floor((closeTs - event.openedAt) / 1000));
      changed = true;
    }
  }

  return changed;
}

async function touchHeartbeat(at = Date.now()) {
  await StorageUtils.set({ lastHeartbeatTs: at });
}

async function createFreshOpenSessionsFromTabs(state, visitEvents, startTs) {
  const openSessions = {};
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    const identity = UrlUtils.getPageIdentity(tab.url);
    if (!identity || !Number.isInteger(tab.id) || isIgnoredPageSession(tab, state) || await isIgnoredIdentity(identity)) {
      continue;
    }

    const session = createOpenSession(tab, identity, startTs);
    openSessions[String(tab.id)] = session;
    addVisitEventToStore(visitEvents, session);
  }

  return openSessions;
}

async function reconcileSuspendedHeartbeat() {
  const now = Date.now();
  const state = await StorageUtils.getState();
  const previousHeartbeat = Math.max(0, Math.floor(state.lastHeartbeatTs || 0));
  const openEntries = Object.values(state.openSessions || {});
  const hasSessions = Boolean(state.activeSession) || openEntries.length > 0;

  if (!previousHeartbeat && !hasSessions) {
    await touchHeartbeat(now);
    return;
  }

  const fallbackCutoff = Math.max(
    0,
    Math.floor(state.activeSession?.lastSavedTs || state.activeSession?.startTs || 0),
    ...openEntries.map((session) => Math.floor(session?.lastSavedTs || session?.startTs || 0))
  );
  const suspendDetected = previousHeartbeat
    ? now - previousHeartbeat > SUSPEND_GAP_MS
    : hasSessions;

  if (!suspendDetected) {
    return;
  }

  const cutoff = Math.max(0, Math.min(previousHeartbeat || fallbackCutoff || now, now));
  const dailyStats = await StorageUtils.getDailyStats();
  const visitEvents = await StorageUtils.getVisitEvents();
  const fallbackTsByVisitId = {};

  if (state.activeSession?.domain && state.activeSession.startTs && cutoff > state.activeSession.startTs) {
    addDuration(dailyStats, state.activeSession.domain, state.activeSession.startTs, cutoff, METRICS.ACTIVE);
    addActiveIntervalToStore(visitEvents, state.activeSession, cutoff);
    fallbackTsByVisitId[state.activeSession.visitId] = cutoff;
  }

  for (const session of openEntries) {
    if (!session?.domain || !session.startTs) {
      continue;
    }

    const endTs = Math.max(session.startTs, cutoff);
    if (endTs > session.startTs) {
      addDuration(dailyStats, session.domain, session.startTs, endTs, METRICS.OPEN);
    }
    finishVisitEventInStore(visitEvents, session, endTs);
    fallbackTsByVisitId[session.visitId] = endTs;
  }

  repairOrphanOpenVisitEvents(visitEvents, new Set(), fallbackTsByVisitId);
  enforceOpenCoversActive(dailyStats);

  const nextOpenSessions = state.trackingPaused
    ? {}
    : await createFreshOpenSessionsFromTabs(state, visitEvents, now);

  await StorageUtils.set({
    activeSession: null,
    dailyStats,
    lastHeartbeatTs: now,
    openSessions: nextOpenSessions,
    visitEvents
  });
}

async function hydrateOpenSessions() {
  const state = await StorageUtils.getState();
  if (state.trackingPaused) {
    await StorageUtils.set({ lastHeartbeatTs: Date.now(), openSessions: {} });
    return;
  }

  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const openSessions = {};
  const visitEvents = await StorageUtils.getVisitEvents();

  for (const tab of tabs) {
    const identity = UrlUtils.getPageIdentity(tab.url);
    if (!identity || !Number.isInteger(tab.id) || isIgnoredPageSession(tab, state) || await isIgnoredIdentity(identity)) {
      continue;
    }

    const existingSession = state.openSessions?.[String(tab.id)];
    if (existingSession?.domain && existingSession.url === identity.url) {
      openSessions[String(tab.id)] = existingSession;
      continue;
    }

    const session = createOpenSession(tab, identity, now);
    openSessions[String(tab.id)] = session;
    addVisitEventToStore(visitEvents, session);
  }

  await StorageUtils.set({ lastHeartbeatTs: now, openSessions, visitEvents });
}

async function syncOpenSessionsWithTabs() {
  const state = await StorageUtils.getState();
  if (state.trackingPaused) {
    await StorageUtils.set({ openSessions: {} });
    return;
  }

  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const currentTabIds = new Set();
  const openSessions = { ...(state.openSessions || {}) };
  const dailyStats = await StorageUtils.getDailyStats();
  const visitEvents = await StorageUtils.getVisitEvents();
  let changed = false;

  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) {
      continue;
    }

    const tabKey = String(tab.id);
    currentTabIds.add(tabKey);
    const identity = UrlUtils.getPageIdentity(tab.url);

    if (!identity) {
      if (openSessions[tabKey]?.domain) {
        addDuration(dailyStats, openSessions[tabKey].domain, openSessions[tabKey].startTs, now, METRICS.OPEN);
        finishVisitEventInStore(visitEvents, openSessions[tabKey], now);
        delete openSessions[tabKey];
        changed = true;
      }
      continue;
    }

    if (isIgnoredPageSession(tab, state)) {
      if (openSessions[tabKey]?.domain) {
        addDuration(dailyStats, openSessions[tabKey].domain, openSessions[tabKey].startTs, now, METRICS.OPEN);
        finishVisitEventInStore(visitEvents, openSessions[tabKey], now);
        delete openSessions[tabKey];
        changed = true;
      }
      continue;
    }

    if (await isIgnoredIdentity(identity)) {
      if (openSessions[tabKey]?.domain) {
        addDuration(dailyStats, openSessions[tabKey].domain, openSessions[tabKey].startTs, now, METRICS.OPEN);
        finishVisitEventInStore(visitEvents, openSessions[tabKey], now);
        delete openSessions[tabKey];
        changed = true;
      }
      continue;
    }

    const currentSession = openSessions[tabKey];
    if (currentSession?.domain && currentSession.url === identity.url) {
      continue;
    }

    if (currentSession?.domain) {
      addDuration(dailyStats, currentSession.domain, currentSession.startTs, now, METRICS.OPEN);
      finishVisitEventInStore(visitEvents, currentSession, now);
    }

    const nextSession = createOpenSession(tab, identity, now);
    openSessions[tabKey] = nextSession;
    addVisitEventToStore(visitEvents, nextSession);
    changed = true;
  }

  for (const tabKey of Object.keys(openSessions)) {
    if (!currentTabIds.has(tabKey)) {
      if (openSessions[tabKey]?.domain) {
        addDuration(dailyStats, openSessions[tabKey].domain, openSessions[tabKey].startTs, now, METRICS.OPEN);
        finishVisitEventInStore(visitEvents, openSessions[tabKey], now);
      }
      delete openSessions[tabKey];
      changed = true;
    }
  }

  if (changed) {
    await StorageUtils.set({ dailyStats, openSessions, visitEvents });
  }
}

async function settleOpenSession(tabId, { keepRunning = false, nextTab = null } = {}) {
  const state = await StorageUtils.getState();
  const openSessions = { ...(state.openSessions || {}) };
  const key = String(tabId);
  const session = openSessions[key];

  if (session?.domain && session.startTs) {
    const now = Date.now();
    const dailyStats = await StorageUtils.getDailyStats();
    const visitEvents = await StorageUtils.getVisitEvents();
    addDuration(dailyStats, session.domain, session.startTs, now, METRICS.OPEN);

    if (keepRunning) {
      openSessions[key] = { ...session, startTs: now, lastSavedTs: now };
      checkpointVisitEventInStore(visitEvents, session, now);
    } else {
      finishVisitEventInStore(visitEvents, session, now);
      delete openSessions[key];
    }

    await StorageUtils.set({ dailyStats, openSessions, visitEvents });
  }

  if (nextTab) {
    await beginOpenSessionForTab(nextTab);
  }
}

async function beginOpenSessionForTab(tab) {
  const identity = UrlUtils.getPageIdentity(tab?.url);
  const state = await StorageUtils.getState();
  if (!identity || !Number.isInteger(tab.id) || isIgnoredPageSession(tab, state) || await isIgnoredIdentity(identity)) {
    return;
  }

  if (state.trackingPaused) {
    return;
  }

  const openSessions = { ...(state.openSessions || {}) };
  const now = Date.now();
  const visitEvents = await StorageUtils.getVisitEvents();
  const session = createOpenSession(tab, identity, now);

  openSessions[String(tab.id)] = session;
  addVisitEventToStore(visitEvents, session);

  await StorageUtils.set({ openSessions, visitEvents });
}

async function ensureOpenSessionForTab(tab, startTs = Date.now()) {
  const identity = UrlUtils.getPageIdentity(tab?.url);
  const state = await StorageUtils.getState();
  if (!identity || !Number.isInteger(tab.id) || isIgnoredPageSession(tab, state) || await isIgnoredIdentity(identity)) {
    return;
  }

  if (state.trackingPaused) {
    return;
  }

  const key = String(tab.id);
  const currentSession = state.openSessions?.[key];
  if (currentSession?.domain && currentSession.url === identity.url) {
    return currentSession;
  }

  const openSessions = { ...(state.openSessions || {}) };
  const dailyStats = await StorageUtils.getDailyStats();
  const visitEvents = await StorageUtils.getVisitEvents();

  if (currentSession?.domain && currentSession.startTs) {
    addDuration(dailyStats, currentSession.domain, currentSession.startTs, startTs, METRICS.OPEN);
    finishVisitEventInStore(visitEvents, currentSession, startTs);
  }

  const session = createOpenSession(tab, identity, startTs);
  openSessions[key] = session;
  addVisitEventToStore(visitEvents, session);
  await StorageUtils.set({ dailyStats, openSessions, visitEvents });
  return session;
}

async function settleActiveSession({ keepRunning = false } = {}) {
  const state = await StorageUtils.getState();
  const session = state.activeSession;

  if (!session?.domain || !session.startTs) {
    return state;
  }

  const now = Date.now();
  const dailyStats = await StorageUtils.getDailyStats();
  const visitEvents = await StorageUtils.getVisitEvents();
  addDuration(dailyStats, session.domain, session.startTs, now, METRICS.ACTIVE);
  addActiveIntervalToStore(visitEvents, session, now);
  enforceOpenCoversActive(dailyStats, null, session.domain);

  const nextSession = keepRunning
    ? { ...session, startTs: now, lastSavedTs: now }
    : null;

  await StorageUtils.set({
    activeSession: nextSession,
    dailyStats,
    visitEvents
  });

  return {
    ...state,
    activeSession: nextSession
  };
}

async function beginSessionForTab(tab, windowId) {
  const identity = UrlUtils.getPageIdentity(tab?.url);
  const state = await StorageUtils.getState();

  if (!identity || isIgnoredPageSession(tab, state) || await isIgnoredIdentity(identity) || state.trackingPaused || state.idleState === "locked") {
    await StorageUtils.set({ activeSession: null });
    return;
  }

  const now = Date.now();

  const openSession = await ensureOpenSessionForTab(tab, now);
  await StorageUtils.set({
    activeSession: {
      visitId: openSession?.visitId || null,
      domain: identity.domain,
      url: identity.url,
      title: tab.title || identity.domain,
      tabId: tab.id,
      windowId,
      startTs: now,
      lastSavedTs: now
    }
  });
}

async function switchToFocusedTab(windowId) {
  await settleActiveSession();
  const tab = await getFocusedActiveTab(windowId);
  await StorageUtils.set({ focusedWindowId: windowId });
  await beginSessionForTab(tab, windowId);
}

async function refreshFocusedSession() {
  const windowId = await getLastFocusedWindowId();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await settleActiveSession();
    await StorageUtils.set({ focusedWindowId: windowId, activeSession: null });
    return;
  }

  await switchToFocusedTab(windowId);
}

async function checkpointActiveSession() {
  const state = await StorageUtils.getState();
  const canKeepRunning =
    !state.trackingPaused &&
    state.idleState !== "locked" &&
    state.focusedWindowId !== chrome.windows.WINDOW_ID_NONE &&
    Boolean(state.activeSession);

  await settleActiveSession({ keepRunning: canKeepRunning });
}

async function checkpointOpenSessions({ keepRunning = true } = {}) {
  const state = await StorageUtils.getState();
  const openSessions = state.openSessions || {};
  const openEntries = Object.values(openSessions);

  if (!openEntries.length) {
    return;
  }

  const now = Date.now();
  const dailyStats = await StorageUtils.getDailyStats();
  const visitEvents = await StorageUtils.getVisitEvents();
  const nextOpenSessions = {};

  for (const session of openEntries) {
    if (!session?.domain || !session.startTs) {
      continue;
    }

    addDuration(dailyStats, session.domain, session.startTs, now, METRICS.OPEN);
    checkpointVisitEventInStore(visitEvents, session, now);
    if (keepRunning) {
      nextOpenSessions[String(session.tabId)] = {
        ...session,
        startTs: now,
        lastSavedTs: now
      };
    }
  }

  await StorageUtils.set({
    dailyStats,
    openSessions: nextOpenSessions,
    visitEvents
  });
}

function dayRows(day) {
  return Object.entries(day || {})
    .map(([domain, value]) => ({
      domain,
      ...normalizeStatsEntry(value)
    }))
    .sort((a, b) => b.activeSeconds - a.activeSeconds);
}

function sanitizeSettings(settings) {
  return {
    ...settings,
    summaryModel: {
      ...settings.summaryModel,
      apiKey: settings.summaryModel.apiKey ? "[configured]" : ""
    },
    analysisModel: {
      ...settings.analysisModel,
      apiKey: settings.analysisModel.apiKey ? "[configured]" : ""
    },
    webdav: {
      ...settings.webdav,
      password: settings.webdav.password ? "[configured]" : ""
    },
    localArchive: {
      ...settings.localArchive
    }
  };
}

async function exportFullData() {
  await checkpointActiveSession();
  await syncOpenSessionsWithTabs();
  await checkpointOpenSessions();
  const dailyStats = await rebuildAndStoreDailyStats();

  const settings = await StorageUtils.getSettings();
  return {
    exportedAt: Date.now(),
    version: 1,
    timezone: TimeUtils.systemTimeZone(),
    dailyStats,
    visitEvents: await StorageUtils.getVisitEvents(),
    pageSummaries: await StorageUtils.getPageSummaries(),
    analysisReports: await StorageUtils.getAnalysisReports(),
    settings: sanitizeSettings(settings)
  };
}

async function exportDiagnosticLogs() {
  return {
    exportedAt: Date.now(),
    version: 1,
    timezone: TimeUtils.systemTimeZone(),
    logs: await StorageUtils.getDiagnosticLogs()
  };
}

async function callChatModel(config, prompt, content, { json = false, maxTokens = null, fast = false, timeoutMs = MODEL_REQUEST_TIMEOUT_MS } = {}) {
  const endpoints = chatCompletionEndpoints(config);
  if (!endpoints.length || !config?.model) {
    throw attachDiagnostic(new Error("Model base URL and model are required."), {
      ...modelLogFields(config),
      stage: "validate",
      jsonMode: Boolean(json),
      maxTokens,
      timeoutMs
    });
  }
  if (!config.apiKey && !isLocalModelConfig(config)) {
    throw attachDiagnostic(new Error("Model API key is required."), {
      ...modelLogFields(config),
      stage: "validate",
      jsonMode: Boolean(json),
      maxTokens,
      timeoutMs
    });
  }

  const headers = {
    "Content-Type": "application/json"
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content }
    ],
    temperature: 0.2
  };

  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    body.max_tokens = Math.floor(Number(maxTokens));
  }

  if (isSiliconFlowConfig(config) && (fast || json)) {
    body.enable_thinking = false;
  }

  if (shouldUseJsonMode(config, json)) {
    body.response_format = { type: "json_object" };
  }

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const data = await requestChatCompletion(endpoint, headers, body, config, timeoutMs);
      const text = data.choices?.[0]?.message?.content
        || data.message?.content
        || data.output_text
        || data.output?.[0]?.content?.[0]?.text;

      if (typeof text !== "string" || !text.trim()) {
        throw new Error("Model response did not include assistant text.");
      }

      return {
        text: text.trim(),
        usage: normalizeTokenUsage(data.usage)
      };
    } catch (error) {
      lastError = error;
      if ([400, 401, 403].includes(error.status)) {
        break;
      }
    }
  }

  throw lastError || new Error("Model request failed.");
}

async function requestChatCompletion(endpoint, headers, body, config, timeoutMs) {
  const requestDetails = (extra = {}, requestBody = body) => modelRequestDiagnostic(config, endpoint, requestBody, timeoutMs, extra);
  let response = null;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    }, timeoutMs);
  } catch (error) {
    throw attachDiagnostic(error, requestDetails({ stage: "fetch" }));
  }

  if (!response.ok && body.response_format && isSiliconFlowConfig(config) && [400, 422].includes(response.status)) {
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    try {
      response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(fallbackBody)
      }, timeoutMs);
    } catch (error) {
      throw attachDiagnostic(error, requestDetails({ stage: "fetch", jsonModeFallback: true }, fallbackBody));
    }
  }

  if (!response.ok) {
    const detail = await modelErrorDetail(response, endpoint);
    const error = new Error(detail.message);
    error.status = response.status;
    throw attachDiagnostic(error, requestDetails({
      stage: "response",
      status: response.status,
      statusText: response.statusText,
      responseTextExcerpt: detail.responseTextExcerpt
    }));
  }

  try {
    return await response.json();
  } catch (error) {
    throw attachDiagnostic(new Error(`Model response JSON parse failed: ${error.message || error}`), requestDetails({
      stage: "parse_response",
      status: response.status,
      statusText: response.statusText
    }));
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Model request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw new Error(`Model request failed before receiving a response: ${error.message || error}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function modelErrorDetail(response, endpoint = "") {
  let responseTextExcerpt = "";
  try {
    const text = await response.text();
    if (text) {
      responseTextExcerpt = text.slice(0, LOG_RESPONSE_EXCERPT_CHARS);
    }
  } catch {
    responseTextExcerpt = "";
  }

  return {
    responseTextExcerpt,
    message: `Model request failed${endpoint ? ` at ${sanitizeUrlForLog(endpoint)}` : ""}: ${response.status} ${response.statusText}${responseTextExcerpt ? ` - ${responseTextExcerpt}` : ""}`
  };
}

function isSiliconFlowConfig(config) {
  const provider = String(config?.provider || "").toLowerCase();
  const baseUrl = String(config?.baseUrl || config?.endpoint || "").toLowerCase();
  return provider === "siliconflow" || baseUrl.includes("siliconflow.");
}

function isLocalModelConfig(config) {
  const provider = String(config?.provider || "").toLowerCase();
  const baseUrl = String(config?.baseUrl || config?.endpoint || "").toLowerCase();
  return provider === "ollama" || baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
}

function siliconFlowSupportsJsonMode(config) {
  if (!isSiliconFlowConfig(config)) {
    return true;
  }

  const model = String(config?.model || "").toLowerCase();
  return !/deepseek-(r1|v3)/i.test(model);
}

function shouldUseJsonMode(config, json) {
  return Boolean(json && siliconFlowSupportsJsonMode(config));
}

function chatCompletionEndpoints(config) {
  const primary = config.endpoint || buildChatCompletionsEndpoint(config.baseUrl);
  return primary ? [primary] : [];
}

function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens);

  if (!promptTokens && !completionTokens && !totalTokens) {
    return null;
  }

  return {
    prompt_tokens: Math.max(0, Math.floor(promptTokens || 0)),
    completion_tokens: Math.max(0, Math.floor(completionTokens || 0)),
    total_tokens: Math.max(0, Math.floor(totalTokens || 0))
  };
}

function buildChatCompletionsEndpoint(baseUrl) {
  if (!baseUrl) {
    return "";
  }

  const normalized = String(baseUrl).trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }

  return `${normalized}/chat/completions`;
}

function normalizeSummaryJson(rawText) {
  const parsed = parseJsonObjectFromText(rawText) || { summary: rawText };

  return {
    summary: String(parsed.summary || ""),
    topics: Array.isArray(parsed.topics) ? parsed.topics.map(String).slice(0, 12) : [],
    contentType: String(parsed.contentType || "other"),
    intent: String(parsed.intent || ""),
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String).slice(0, 12) : [],
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null
  };
}

async function logInvalidSummaryJson({ identity, summaryId, visitId = "", resultText, settings, operation = "summary_model_invalid_json" }) {
  await addDiagnosticLog({
    level: "warn",
    priority: "medium",
    source: "records",
    category: "external",
    operation,
    message: "Summary model returned text that could not be parsed as structured JSON.",
    domain: identity?.domain || "",
    url: identity?.url || "",
    summaryId,
    visitId,
    ...modelLogFields(settings?.summaryModel || {}),
    details: {
      responseTextExcerpt: String(resultText || "").slice(0, LOG_RESPONSE_EXCERPT_CHARS),
      expectedShape: "summary/topics/contentType/intent/keyPoints/confidence"
    }
  });
}

function parseJsonObjectFromText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    // Try common model output wrappers below.
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // Try embedded object extraction below.
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeDomainList(domains) {
  return [...new Set((domains || [])
    .map((domain) => String(domain).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase())
    .filter(Boolean))]
    .sort();
}

function baseCaptureMeta(overrides = {}) {
  return {
    captureMethod: CAPTURE_METHOD.METADATA_ONLY,
    captureStatus: CAPTURE_STATUS.UNSUPPORTED,
    evidenceLevel: EVIDENCE_LEVEL.LOW,
    sourceCharCount: 0,
    screenshotCapturedAt: null,
    screenshotWindowId: null,
    screenshotAttemptedAt: null,
    captureDiagnostics: null,
    captureError: "",
    ...overrides
  };
}

function applyCaptureMeta(record, capture) {
  const meta = baseCaptureMeta(capture);
  record.captureMethod = meta.captureMethod;
  record.captureStatus = meta.captureStatus;
  record.evidenceLevel = meta.evidenceLevel;
  record.sourceCharCount = meta.sourceCharCount;
  record.screenshotCapturedAt = meta.screenshotCapturedAt;
  record.screenshotWindowId = meta.screenshotWindowId;
  record.screenshotAttemptedAt = meta.screenshotAttemptedAt;
  record.captureDiagnostics = meta.captureDiagnostics;
  record.captureError = meta.captureError;
}

function buildTextSummaryContent(identity, tab, captured) {
  return [
    `URL: ${identity.url}`,
    `Title: ${captured.title || tab.title || identity.domain}`,
    `Capture method: ${CAPTURE_METHOD.DOM_TEXT}`,
    `Evidence level: ${EVIDENCE_LEVEL.HIGH}`,
    "",
    "Content:",
    captured.text
  ].join("\n");
}

function buildScreenshotSummaryContent(identity, tab, imageDataUrl) {
  return [
    {
      type: "text",
      text: [
        `URL: ${identity.url}`,
        `Title: ${tab.title || identity.domain}`,
        `Capture method: ${CAPTURE_METHOD.SCREENSHOT_VISION}`,
        `Evidence level: ${EVIDENCE_LEVEL.MEDIUM}`,
        "",
        "The DOM text extractor was blocked or produced too little content. Analyze only what is visible in this screenshot. Do not infer hidden content outside the screenshot. Return the configured summary JSON."
      ].join("\n")
    },
    {
      type: "image_url",
      image_url: {
        url: imageDataUrl,
        detail: "low"
      }
    }
  ];
}

function isScreenshotFallbackAllowed(settings, domain) {
  if (settings.capture.screenshotFallbackEnabled === false) {
    return false;
  }

  const allowlist = normalizeDomainList(settings.capture.screenshotAuthorizedDomains);
  return !allowlist.length || allowlist.includes(domain);
}

async function hasAllUrlsPermission() {
  if (!chrome.permissions?.contains) {
    return true;
  }

  try {
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    return false;
  }
}

async function notifyScreenshotFallbackNeeded(settings, domain) {
  const prompted = settings.capture.screenshotPromptedDomains || {};
  if (prompted[domain]) {
    return settings;
  }

  const nextSettings = {
    ...settings,
    capture: {
      ...settings.capture,
      screenshotPromptedDomains: {
        ...prompted,
        [domain]: Date.now()
      }
    }
  };
  await StorageUtils.setSettings(nextSettings);

  try {
    if (chrome.notifications?.create) {
      await chrome.notifications.create(`screenshot-fallback-${domain}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("assets/icon128.png"),
        title: "Screenshot fallback available",
        message: `${domain} blocked text capture. When this tab is visible, the extension will send a screenshot to the configured vision model for summary.`
      });
    }
  } catch {
    // Notification is best-effort; the pending domain remains visible in Settings.
  }

  return nextSettings;
}

async function extractTabContent(tabId, maxContentChars) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (limit) => {
      const title = document.title || "";
      const url = location.href;
      const blockedSelectors = [
        "script",
        "style",
        "noscript",
        "svg",
        "canvas",
        "iframe",
        "nav",
        "footer",
        "header",
        "[aria-hidden='true']",
        "[hidden]"
      ].join(",");
      const visibleText = (node) => {
        const value = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        if (!value) {
          return "";
        }
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return "";
        }
        return value;
      };
      const description = (document.querySelector("meta[name='description']")?.content || "").trim();
      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .map(visibleText)
        .filter(Boolean)
        .slice(0, 24);
      const contentRoot = document.querySelector("main, article, [role='main']") || document.body;
      const blocks = Array.from(contentRoot?.querySelectorAll("article, section, p, li, blockquote, pre, code, td, th") || [])
        .filter((node) => !node.closest(blockedSelectors))
        .map(visibleText)
        .filter((value, index, values) => value.length >= 2 && values.indexOf(value) === index)
        .slice(0, 240);
      const fallbackText = visibleText(contentRoot || document.body);
      const text = [description, ...headings, ...blocks, blocks.length ? "" : fallbackText]
        .filter(Boolean)
        .join("\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n");
      return {
        title,
        url,
        description,
        text: [description, headings, text].filter(Boolean).join("\n\n").slice(0, limit)
      };
    },
    args: [maxContentChars]
  });

  return result?.result || null;
}

async function captureDomSummarySource(tabId, maxContentChars) {
  try {
    const captured = await extractTabContent(tabId, maxContentChars);
    const text = String(captured?.text || "").trim();
    if (!text) {
      return {
        captured: { ...(captured || {}), text: "" },
        meta: baseCaptureMeta({
          captureMethod: CAPTURE_METHOD.METADATA_ONLY,
          captureStatus: CAPTURE_STATUS.LOW_CONTENT,
          evidenceLevel: EVIDENCE_LEVEL.LOW
        })
      };
    }

    return {
      captured: { ...captured, text },
      meta: baseCaptureMeta({
        captureMethod: CAPTURE_METHOD.DOM_TEXT,
        captureStatus: text.length < MIN_SUMMARY_TEXT_CHARS ? CAPTURE_STATUS.LOW_CONTENT : CAPTURE_STATUS.OK,
        evidenceLevel: text.length < MIN_SUMMARY_TEXT_CHARS ? EVIDENCE_LEVEL.LOW : EVIDENCE_LEVEL.HIGH,
        sourceCharCount: text.length
      })
    };
  } catch (error) {
    return {
      captured: null,
      meta: baseCaptureMeta({
        captureMethod: CAPTURE_METHOD.METADATA_ONLY,
        captureStatus: CAPTURE_STATUS.BLOCKED,
        evidenceLevel: EVIDENCE_LEVEL.LOW,
        captureError: error.message || "Page content capture was blocked."
      })
    };
  }
}

async function linkSummaryToVisit(tabId, summaryId, status) {
  const state = await StorageUtils.getState();
  const visitEvents = await StorageUtils.getVisitEvents();
  const session = state.openSessions?.[String(tabId)] || state.activeSession;

  if (!session?.visitId) {
    return;
  }

  updateVisitEventInStore(visitEvents, session.visitId, (event) => {
    event.summaryId = summaryId;
    event.summaryStatus = status;
  });
  await StorageUtils.setVisitEvents(visitEvents);
}

async function updateVisitSummaryStatus(summaryId, status) {
  const visitEvents = await StorageUtils.getVisitEvents();
  let changed = false;
  for (const dayEvents of Object.values(visitEvents || {})) {
    for (const event of dayEvents || []) {
      if (event.summaryId === summaryId) {
        event.summaryStatus = status;
        changed = true;
      }
    }
  }

  if (changed) {
    await StorageUtils.setVisitEvents(visitEvents);
  }
}

async function updateSummaryRecord(dateKey, summaryId, updater) {
  const pageSummaries = await StorageUtils.getPageSummaries();
  const records = pageSummaries[dateKey] || [];
  const index = records.findIndex((item) => item.id === summaryId);
  if (index < 0) {
    return null;
  }

  updater(records[index]);
  await StorageUtils.setPageSummaries(pageSummaries);
  return records[index];
}

function inferLegacyCaptureMeta(record) {
  if (record.captureMethod && record.captureStatus && record.evidenceLevel) {
    return null;
  }

  const message = String(record.error || record.captureError || "").toLowerCase();
  if (message.includes("blocked")) {
    return baseCaptureMeta({
      captureMethod: CAPTURE_METHOD.METADATA_ONLY,
      captureStatus: CAPTURE_STATUS.BLOCKED,
      evidenceLevel: EVIDENCE_LEVEL.LOW,
      captureError: record.captureError || record.error || "Blocked"
    });
  }

  if (record.status === SUMMARY_STATUS.DONE && record.structuredSummary) {
    return baseCaptureMeta({
      captureMethod: CAPTURE_METHOD.DOM_TEXT,
      captureStatus: CAPTURE_STATUS.OK,
      evidenceLevel: EVIDENCE_LEVEL.HIGH
    });
  }

  return baseCaptureMeta({
    captureMethod: CAPTURE_METHOD.METADATA_ONLY,
    captureStatus: record.status === SUMMARY_STATUS.ERROR ? CAPTURE_STATUS.ERROR : CAPTURE_STATUS.UNSUPPORTED,
    evidenceLevel: EVIDENCE_LEVEL.LOW,
    captureError: record.captureError || record.error || ""
  });
}

async function repairLegacySummaryCaptureMetadata() {
  const pageSummaries = await StorageUtils.getPageSummaries();
  let changed = false;

  for (const records of Object.values(pageSummaries || {})) {
    for (const record of records || []) {
      const meta = inferLegacyCaptureMeta(record);
      if (!meta) {
        continue;
      }

      applyCaptureMeta(record, meta);
      changed = true;
    }
  }

  if (changed) {
    await StorageUtils.setPageSummaries(pageSummaries);
  }

  return pageSummaries;
}

async function captureVisibleTabImage(tab) {
  if (!Number.isInteger(tab?.windowId)) {
    throw new Error("Screenshot fallback requires an active browser window.");
  }

  return chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 72
  });
}

async function captureTabImageWithDebugger(tab) {
  if (!Number.isInteger(tab?.id)) {
    throw new Error("Debugger screenshot requires a tab id.");
  }

  const target = { tabId: tab.id };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 72,
      captureBeyondViewport: false
    });
    if (!result?.data) {
      throw new Error("Debugger screenshot returned no image data.");
    }
    return `data:image/jpeg;base64,${result.data}`;
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch {
        // Best-effort detach; the browser also detaches when the worker stops.
      }
    }
  }
}

async function screenshotDiagnostics(tab, identity, trigger) {
  let activeTabId = null;
  let windowFocused = null;
  let windowType = null;
  let permissionGranted = false;

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    activeTabId = Number.isInteger(activeTab?.id) ? activeTab.id : null;
  } catch {
    activeTabId = null;
  }

  try {
    const window = await chrome.windows.get(tab.windowId, { populate: false });
    windowFocused = Boolean(window?.focused);
    windowType = window?.type || null;
  } catch {
    windowFocused = null;
    windowType = null;
  }

  try {
    permissionGranted = await hasAllUrlsPermission();
  } catch {
    permissionGranted = false;
  }

  return {
    at: Date.now(),
    trigger,
    domain: identity?.domain || "",
    url: identity?.url || tab?.url || "",
    tabId: Number.isInteger(tab?.id) ? tab.id : null,
    windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null,
    tabActive: Boolean(tab?.active),
    activeTabId,
    isActiveTabInWindow: activeTabId === tab?.id,
    windowFocused,
    windowType,
    allUrlsPermission: permissionGranted,
    screenshotApi: "captureVisibleTab"
  };
}

async function captureScreenshotForModel(tab, identity, trigger = "unknown") {
  const diagnostics = await screenshotDiagnostics(tab, identity, trigger);
  const attemptedAt = diagnostics.at || Date.now();

  try {
    let imageDataUrl = "";
    let screenshotApi = "captureVisibleTab";
    try {
      imageDataUrl = await captureVisibleTabImage(tab);
    } catch (visibleTabError) {
      screenshotApi = "debugger.Page.captureScreenshot";
      diagnostics.captureVisibleTabError = visibleTabError.message || String(visibleTabError);
      diagnostics.screenshotApi = screenshotApi;
      imageDataUrl = await captureTabImageWithDebugger(tab);
    }
    return {
      imageDataUrl,
      meta: {
        screenshotAttemptedAt: attemptedAt,
        screenshotCapturedAt: Date.now(),
        screenshotWindowId: tab.windowId,
        captureDiagnostics: {
          ...diagnostics,
          screenshotApi
        }
      }
    };
  } catch (error) {
    const wrapped = new Error("screenshot_capture_failed: This site blocked both standard and fallback screenshot capture.");
    wrapped.screenshotAttemptedAt = attemptedAt;
    wrapped.captureDiagnostics = {
      ...diagnostics,
      finalScreenshotError: error.message || String(error)
    };
    throw wrapped;
  }
}

async function isVisibleActiveTab(tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) {
    return false;
  }

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    return activeTab?.id === tab.id;
  } catch {
    return false;
  }
}

async function summarizeScreenshot(tab, identity, settings, { trigger = "summary", onAttempt = null } = {}) {
  if (!await isVisibleActiveTab(tab)) {
    throw new Error("Screenshot fallback requires the page to be the visible active tab.");
  }

  const screenshotCapture = await captureScreenshotForModel(tab, identity, trigger);
  if (typeof onAttempt === "function") {
    await onAttempt(screenshotCapture.meta);
  }

  let result = null;
  try {
    result = await callChatModel(
      settings.summaryModel,
      settings.summaryModel.prompt,
      buildScreenshotSummaryContent(identity, tab, screenshotCapture.imageDataUrl),
      { json: true, maxTokens: 900 }
    );
  } catch (error) {
    error.screenshotAttemptedAt = screenshotCapture.meta.screenshotAttemptedAt;
    error.screenshotCapturedAt = screenshotCapture.meta.screenshotCapturedAt;
    error.screenshotWindowId = screenshotCapture.meta.screenshotWindowId;
    error.captureDiagnostics = screenshotCapture.meta.captureDiagnostics;
    throw error;
  }

  return {
    result,
    meta: baseCaptureMeta({
      captureMethod: CAPTURE_METHOD.SCREENSHOT_VISION,
      captureStatus: CAPTURE_STATUS.OK,
      evidenceLevel: EVIDENCE_LEVEL.MEDIUM,
      ...screenshotCapture.meta
    })
  };
}

async function createSummaryRecordForTab(tab, settings, status = SUMMARY_STATUS.PENDING) {
  const identity = UrlUtils.getPageIdentity(tab?.url);
  if (!identity || !Number.isInteger(tab.id) || await isIgnoredIdentity(identity)) {
    throw new Error("Only normal http/https pages can be summarized.");
  }

  const summaryId = crypto.randomUUID();
  const now = Date.now();
  const dateKey = TimeUtils.dateKeyFromTimestamp(now);
  const pageSummaries = await StorageUtils.getPageSummaries();
  pageSummaries[dateKey] = pageSummaries[dateKey] || [];

  const record = {
    id: summaryId,
    createdAt: now,
    domain: identity.domain,
    url: identity.url,
    title: tab.title || identity.domain,
    status,
    model: settings.summaryModel.model,
    prompt: settings.summaryModel.prompt,
    summary: "",
    structuredSummary: null,
    usage: null,
    error: "",
    ...baseCaptureMeta({
      captureStatus: CAPTURE_STATUS.UNSUPPORTED
    })
  };
  pageSummaries[dateKey].push(record);
  await StorageUtils.setPageSummaries(pageSummaries);
  await linkSummaryToVisit(tab.id, summaryId, status);

  return { record, dateKey, identity };
}

async function logSummaryCaptureIssue({ identity, summaryId, visitId, captureMeta, message, priority = "low", category = "site", operation = "capture_page_content" }) {
  await addDiagnosticLog({
    level: priority === "low" ? "warn" : "error",
    priority,
    source: "records",
    category,
    operation,
    message,
    domain: identity?.domain || "",
    url: identity?.url || "",
    summaryId,
    visitId,
    details: {
      captureMethod: captureMeta?.captureMethod || "",
      captureStatus: captureMeta?.captureStatus || "",
      evidenceLevel: captureMeta?.evidenceLevel || "",
      sourceCharCount: captureMeta?.sourceCharCount || 0,
      captureError: captureMeta?.captureError || "",
      screenshotAttemptedAt: captureMeta?.screenshotAttemptedAt || null,
      screenshotCapturedAt: captureMeta?.screenshotCapturedAt || null,
      captureDiagnostics: captureMeta?.captureDiagnostics || null
    }
  });
}

async function runSummaryRecord({ tabId, url, summaryId, dateKey, visitId, immediate = false }) {
  if (!immediate) {
    await delay(2000);
  }

  setLastSummaryStatus("capturing", "Capturing page content.", { summaryId });

  let tab = null;
  let lastCaptureMeta = baseCaptureMeta();
  let attemptedScreenshot = false;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await updateSummaryRecord(dateKey, summaryId, (record) => {
      record.status = SUMMARY_STATUS.SKIPPED;
      record.error = "Page was closed before content could be captured.";
    });
    await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.SKIPPED);
    setLastSummaryStatus("skipped", "Page was closed before content could be captured.", { summaryId });
    if (visitId) {
      pendingSummaryVisitIds.delete(visitId);
    }
    return null;
  }

  if (tab.url !== url) {
    await updateSummaryRecord(dateKey, summaryId, (record) => {
      record.status = SUMMARY_STATUS.SKIPPED;
      record.error = "Page URL changed before summarization.";
    });
    await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.SKIPPED);
    setLastSummaryStatus("skipped", "Page URL changed before summarization.", { summaryId });
    if (visitId) {
      pendingSummaryVisitIds.delete(visitId);
    }
    return null;
  }

  const identity = UrlUtils.getPageIdentity(tab.url);
  if (!identity || await isIgnoredIdentity(identity)) {
    await updateSummaryRecord(dateKey, summaryId, (record) => {
      record.status = SUMMARY_STATUS.SKIPPED;
      record.error = "Page became ignored or unsupported before summarization.";
    });
    await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.SKIPPED);
    setLastSummaryStatus("skipped", "Page became ignored or unsupported before summarization.", { summaryId });
    if (visitId) {
      pendingSummaryVisitIds.delete(visitId);
    }
    return null;
  }

  const settings = await StorageUtils.getSettings();
  let captured = null;
  try {
    await updateSummaryRecord(dateKey, summaryId, (record) => {
      record.status = SUMMARY_STATUS.CAPTURING;
      record.error = "";
    });
    await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.CAPTURING);

    const firstCapture = await captureDomSummarySource(tabId, settings.capture.maxContentChars);
    captured = firstCapture.captured;
    let captureMeta = firstCapture.meta;
    lastCaptureMeta = captureMeta;
    if (captureMeta.captureStatus === CAPTURE_STATUS.LOW_CONTENT) {
      await delay(1800);
      const secondCapture = await captureDomSummarySource(tabId, settings.capture.maxContentChars);
      captured = secondCapture.captured;
      captureMeta = secondCapture.meta;
      lastCaptureMeta = captureMeta;
    }

    await updateSummaryRecord(dateKey, summaryId, (record) => {
      applyCaptureMeta(record, captureMeta);
      record.title = captured?.title || tab.title || record.title;
      record.captureError = captureMeta.captureError || "";
    });

    if ([CAPTURE_STATUS.BLOCKED, CAPTURE_STATUS.LOW_CONTENT].includes(captureMeta.captureStatus)) {
      await logSummaryCaptureIssue({
        identity,
        summaryId,
        visitId,
        captureMeta,
        message: captureMeta.captureStatus === CAPTURE_STATUS.BLOCKED
          ? "Page content capture was blocked; screenshot fallback may be needed."
          : "Page content capture returned low content; summary evidence may be weak."
      });
    }

    if (captureMeta.captureStatus !== CAPTURE_STATUS.OK) {
      await notifyScreenshotFallbackNeeded(settings, identity.domain);

      if (!isScreenshotFallbackAllowed(settings, identity.domain)) {
        const updated = await updateSummaryRecord(dateKey, summaryId, (record) => {
          record.status = SUMMARY_STATUS.ERROR;
          record.summary = "";
          record.structuredSummary = null;
          record.usage = null;
          record.error = "screenshot_fallback_disabled: Screenshot fallback is disabled or this domain is not allowed for screenshot summaries.";
          applyCaptureMeta(record, captureMeta);
          record.captureError = record.error;
        });
        await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.ERROR);
        setLastSummaryStatus("error", "Screenshot fallback is disabled or this domain is not allowed.", {
          summaryId,
          domain: identity.domain,
          captureStatus: captureMeta.captureStatus
        });
        await logSummaryCaptureIssue({
          identity,
          summaryId,
          visitId,
          captureMeta: {
            ...captureMeta,
            captureError: updated?.error || captureMeta.captureError
          },
          priority: "medium",
          category: "configuration",
          operation: "screenshot_fallback_disabled",
          message: updated?.error || "Screenshot fallback is disabled or this domain is not allowed."
        });
        return updated;
      }

      if (!await isVisibleActiveTab(tab)) {
        const updated = await updateSummaryRecord(dateKey, summaryId, (record) => {
          record.status = SUMMARY_STATUS.CAPTURING;
          record.summary = "";
          record.structuredSummary = null;
          record.usage = null;
          record.error = "screenshot_waiting_for_visible_tab: Page text capture was blocked. Activate this tab so screenshot fallback can summarize it.";
          applyCaptureMeta(record, {
            ...captureMeta,
            captureStatus: CAPTURE_STATUS.WAITING_VISIBLE_TAB
          });
          record.captureError = record.error;
        });
        await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.CAPTURING);
        setLastSummaryStatus("waiting", "Blocked page is waiting for the tab to become visible for screenshot fallback.", {
          summaryId,
          domain: identity.domain,
          captureStatus: CAPTURE_STATUS.WAITING_VISIBLE_TAB
        });
        await logSummaryCaptureIssue({
          identity,
          summaryId,
          visitId,
          captureMeta: {
            ...captureMeta,
            captureStatus: CAPTURE_STATUS.WAITING_VISIBLE_TAB,
            captureError: updated?.error || captureMeta.captureError
          },
          priority: "low",
          category: "site",
          operation: "screenshot_waiting_visible_tab",
          message: updated?.error || "Blocked page is waiting for a visible active tab."
        });
        return updated;
      }

      await updateSummaryRecord(dateKey, summaryId, (record) => {
        record.status = SUMMARY_STATUS.SUMMARIZING;
      });
      await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.SUMMARIZING);
      setLastSummaryStatus("summarizing", "Calling summary model with screenshot fallback.", {
        summaryId,
        domain: identity.domain
      });

      attemptedScreenshot = true;
      const screenshotSummary = await summarizeScreenshot(tab, identity, settings, {
        trigger: "initial_summary",
        onAttempt: async (meta) => {
          await updateSummaryRecord(dateKey, summaryId, (record) => {
            applyCaptureMeta(record, baseCaptureMeta({
              captureMethod: CAPTURE_METHOD.SCREENSHOT_VISION,
              captureStatus: CAPTURE_STATUS.SCREENSHOT_ATTEMPTING,
              evidenceLevel: EVIDENCE_LEVEL.LOW,
              ...meta
            }));
          });
        }
      });
      lastCaptureMeta = screenshotSummary.meta;
      if (!parseJsonObjectFromText(screenshotSummary.result.text)) {
        await logInvalidSummaryJson({
          identity,
          summaryId,
          visitId,
          resultText: screenshotSummary.result.text,
          settings,
          operation: "summary_screenshot_invalid_json"
        });
      }
      const updated = await updateSummaryRecord(dateKey, summaryId, (record) => {
        record.status = SUMMARY_STATUS.DONE;
        record.title = tab.title || record.title;
        record.summary = screenshotSummary.result.text;
        record.structuredSummary = normalizeSummaryJson(screenshotSummary.result.text);
        record.usage = screenshotSummary.result.usage;
        record.error = "";
        applyCaptureMeta(record, screenshotSummary.meta);
      });
      await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.DONE);
      await updateScreenshotLastCapture(settings, identity.domain, screenshotSummary.meta.screenshotCapturedAt);
      setLastSummaryStatus("done", "Screenshot fallback summary completed.", {
        summaryId,
        domain: identity.domain
      });
      return updated;
    }

    await updateSummaryRecord(dateKey, summaryId, (record) => {
      record.status = SUMMARY_STATUS.SUMMARIZING;
      record.title = captured.title || tab.title || record.title;
    });
    await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.SUMMARIZING);
    setLastSummaryStatus("summarizing", "Calling summary model.", { summaryId, domain: identity.domain });

    const result = await callChatModel(
      settings.summaryModel,
      settings.summaryModel.prompt,
      buildTextSummaryContent(identity, tab, captured),
      { json: true, maxTokens: 900 }
    );
    if (!parseJsonObjectFromText(result.text)) {
      await logInvalidSummaryJson({
        identity,
        summaryId,
        visitId,
        resultText: result.text,
        settings,
        operation: "summary_text_invalid_json"
      });
    }
    const updated = await updateSummaryRecord(dateKey, summaryId, (record) => {
      record.status = SUMMARY_STATUS.DONE;
      record.title = captured.title || tab.title || record.title;
      record.summary = result.text;
      record.structuredSummary = normalizeSummaryJson(result.text);
      record.usage = result.usage;
      record.error = "";
      applyCaptureMeta(record, captureMeta);
    });
    await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.DONE);
    setLastSummaryStatus("done", "Summary completed.", { summaryId, domain: identity.domain });
    return updated;
  } catch (error) {
    const updated = await updateSummaryRecord(dateKey, summaryId, (record) => {
      record.status = SUMMARY_STATUS.ERROR;
      record.error = error.message || "Summary failed.";
      const message = error.message || "Summary failed.";
      const fallbackMeta = attemptedScreenshot
        ? baseCaptureMeta({
          captureMethod: CAPTURE_METHOD.SCREENSHOT_VISION,
          captureStatus: CAPTURE_STATUS.ERROR,
          evidenceLevel: EVIDENCE_LEVEL.LOW,
          screenshotAttemptedAt: error.screenshotAttemptedAt || null,
          screenshotCapturedAt: error.screenshotCapturedAt || null,
          screenshotWindowId: error.screenshotWindowId || null,
          captureDiagnostics: error.captureDiagnostics || null,
          captureError: message
        })
        : message.toLowerCase().includes("blocked")
          ? baseCaptureMeta({
            captureMethod: CAPTURE_METHOD.METADATA_ONLY,
            captureStatus: CAPTURE_STATUS.BLOCKED,
            evidenceLevel: EVIDENCE_LEVEL.LOW,
            captureError: message
          })
          : baseCaptureMeta({
            ...lastCaptureMeta,
            captureStatus: lastCaptureMeta.captureStatus === CAPTURE_STATUS.UNSUPPORTED ? CAPTURE_STATUS.ERROR : lastCaptureMeta.captureStatus,
            evidenceLevel: lastCaptureMeta.evidenceLevel || EVIDENCE_LEVEL.LOW,
            captureError: lastCaptureMeta.captureError || message
          });
      applyCaptureMeta(record, fallbackMeta);
    });
    await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.ERROR);
    setLastSummaryStatus("error", error.message || "Summary failed.", { summaryId });
    await addDiagnosticLog({
      level: "error",
      priority: errorPriority(error, "medium"),
      source: "records",
      category: errorCategory(error, attemptedScreenshot ? "site" : "external"),
      operation: attemptedScreenshot ? "summarize_screenshot_fallback" : "summarize_page",
      message: error.message || "Summary failed.",
      domain: identity.domain,
      url: identity.url,
      summaryId,
      visitId,
      status: error.status || null,
      ...modelLogFields(settings.summaryModel),
      details: {
        dateKey,
        attemptedScreenshot,
        captureMeta: lastCaptureMeta,
        diagnostic: error.diagnostic || null
      },
      error
    });
    return updated;
  } finally {
    if (visitId) {
      pendingSummaryVisitIds.delete(visitId);
    }
  }
}

async function summarizeTab(tab) {
  const settings = await StorageUtils.getSettings();
  const { record, dateKey } = await createSummaryRecordForTab(tab, settings, SUMMARY_STATUS.PENDING);
  return runSummaryRecord({
    tabId: tab.id,
    url: tab.url,
    summaryId: record.id,
    dateKey,
    visitId: null,
    immediate: true
  });
}

function scheduleSummaryTask(task) {
  enqueueSummaryOperation(() => runSummaryRecord(task));
}

function findSummaryRecord(pageSummaries, summaryId) {
  if (!summaryId) {
    return null;
  }

  for (const [dateKey, records] of Object.entries(pageSummaries || {})) {
    const record = (records || []).find((item) => item.id === summaryId);
    if (record) {
      return { dateKey, record };
    }
  }

  return null;
}

async function updateScreenshotLastCapture(settings, domain, capturedAt) {
  await StorageUtils.setSettings({
    ...settings,
    capture: {
      ...settings.capture,
      screenshotLastCaptureByDomain: {
        ...(settings.capture.screenshotLastCaptureByDomain || {}),
        [domain]: capturedAt
      }
    }
  });
}

async function maybeScreenshotFallbackActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const identity = UrlUtils.getPageIdentity(tab?.url);
  if (!identity || !Number.isInteger(tab.id) || await isIgnoredIdentity(identity)) {
    return null;
  }

  const settings = await StorageUtils.getSettings();
  if (!isScreenshotFallbackAllowed(settings, identity.domain)) {
    return null;
  }

  const state = await StorageUtils.getState();
  const session = state.openSessions?.[String(tab.id)];
  if (!session?.visitId || pendingSummaryVisitIds.has(session.visitId)) {
    return null;
  }

  const visitEvents = await StorageUtils.getVisitEvents();
  let summaryId = null;
  updateVisitEventInStore(visitEvents, session.visitId, (event) => {
    summaryId = event.summaryId || null;
  });

  if (!summaryId) {
    return maybeAutoSummarizeTab(tab, { silentUnsupported: true });
  }

  const pageSummaries = await StorageUtils.getPageSummaries();
  const match = findSummaryRecord(pageSummaries, summaryId);
  if (!match?.record || match.record.status === SUMMARY_STATUS.PENDING || match.record.status === SUMMARY_STATUS.SUMMARIZING) {
    return null;
  }

  if (![
    CAPTURE_STATUS.BLOCKED,
    CAPTURE_STATUS.LOW_CONTENT,
    CAPTURE_STATUS.WAITING_VISIBLE_TAB,
    CAPTURE_STATUS.SCREENSHOT_ATTEMPTING,
    CAPTURE_STATUS.ERROR
  ].includes(match.record.captureStatus)) {
    return null;
  }

  const lastCapture = Math.max(0, Math.floor(settings.capture.screenshotLastCaptureByDomain?.[identity.domain] || 0));
  const alreadySummarizedByScreenshot = match.record.captureMethod === CAPTURE_METHOD.SCREENSHOT_VISION
    && match.record.status === SUMMARY_STATUS.DONE;
  if (alreadySummarizedByScreenshot && Date.now() - lastCapture < SCREENSHOT_FALLBACK_INTERVAL_MS) {
    return null;
  }

  pendingSummaryVisitIds.add(session.visitId);
  try {
    setLastSummaryStatus("summarizing", "Running scheduled screenshot fallback.", {
      domain: identity.domain,
      summaryId
    });
    const screenshotSummary = await summarizeScreenshot(tab, identity, settings, {
      trigger: "scheduled_fallback",
      onAttempt: async (meta) => {
        await updateSummaryRecord(match.dateKey, summaryId, (record) => {
          applyCaptureMeta(record, baseCaptureMeta({
            captureMethod: CAPTURE_METHOD.SCREENSHOT_VISION,
            captureStatus: CAPTURE_STATUS.SCREENSHOT_ATTEMPTING,
            evidenceLevel: EVIDENCE_LEVEL.LOW,
            ...meta
          }));
        });
      }
    });
    if (!parseJsonObjectFromText(screenshotSummary.result.text)) {
      await logInvalidSummaryJson({
        identity,
        summaryId,
        visitId: session.visitId,
        resultText: screenshotSummary.result.text,
        settings,
        operation: "scheduled_screenshot_invalid_json"
      });
    }
    const updated = await updateSummaryRecord(match.dateKey, summaryId, (record) => {
      record.status = SUMMARY_STATUS.DONE;
      record.title = tab.title || record.title;
      record.summary = screenshotSummary.result.text;
      record.structuredSummary = normalizeSummaryJson(screenshotSummary.result.text);
      record.usage = screenshotSummary.result.usage;
      record.error = "";
      applyCaptureMeta(record, screenshotSummary.meta);
    });
    await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.DONE);
    await updateScreenshotLastCapture(settings, identity.domain, screenshotSummary.meta.screenshotCapturedAt);
    setLastSummaryStatus("done", "Scheduled screenshot fallback completed.", {
      domain: identity.domain,
      summaryId
    });
    return updated;
  } catch (error) {
    await updateSummaryRecord(match.dateKey, summaryId, (record) => {
      record.status = SUMMARY_STATUS.ERROR;
      record.error = error.message || "Screenshot fallback failed.";
      applyCaptureMeta(record, baseCaptureMeta({
        captureMethod: CAPTURE_METHOD.SCREENSHOT_VISION,
        captureStatus: CAPTURE_STATUS.ERROR,
        evidenceLevel: EVIDENCE_LEVEL.LOW,
        screenshotAttemptedAt: error.screenshotAttemptedAt || null,
        screenshotCapturedAt: error.screenshotCapturedAt || null,
        screenshotWindowId: error.screenshotWindowId || null,
        captureDiagnostics: error.captureDiagnostics || null,
        captureError: error.message || "Screenshot fallback failed."
      }));
    });
    await updateVisitSummaryStatus(summaryId, SUMMARY_STATUS.ERROR);
    setLastSummaryStatus("error", error.message || "Screenshot fallback failed.", {
      domain: identity.domain,
      summaryId
    });
    await addDiagnosticLog({
      level: "error",
      priority: errorPriority(error, "medium"),
      source: "records",
      category: errorCategory(error, "site"),
      operation: "scheduled_screenshot_fallback",
      message: error.message || "Screenshot fallback failed.",
      domain: identity.domain,
      url: identity.url,
      summaryId,
      visitId: session.visitId,
      status: error.status || null,
      ...modelLogFields(settings.summaryModel),
      details: {
        dateKey: match.dateKey,
        diagnostic: error.diagnostic || null,
        captureDiagnostics: error.captureDiagnostics || null
      },
      error
    });
    return null;
  } finally {
    pendingSummaryVisitIds.delete(session.visitId);
  }
}

async function maybeAutoSummarizeTab(tab, { silentUnsupported = false } = {}) {
  const identity = UrlUtils.getPageIdentity(tab?.url);
  if (!identity || !Number.isInteger(tab.id)) {
    if (!silentUnsupported) {
      setLastSummaryStatus("skipped", "Current page is not a normal http/https page.");
    }
    return null;
  }

  if (await isIgnoredIdentity(identity)) {
    setLastSummaryStatus("skipped", `${identity.domain} is ignored.`);
    return null;
  }

  const settings = await StorageUtils.getSettings();
  const endpoint = settings.summaryModel.endpoint || buildChatCompletionsEndpoint(settings.summaryModel.baseUrl);
  if (!settings.capture.autoSummarize || !endpoint || !settings.summaryModel.model) {
    setLastSummaryStatus(
      "disabled",
      !settings.capture.autoSummarize
        ? "Auto summarize is turned off."
        : "Summary model is not fully configured."
    );
    return null;
  }

  const state = await StorageUtils.getState();
  const session = state.openSessions?.[String(tab.id)];
  if (!session?.visitId) {
    setLastSummaryStatus("waiting", "No open visit session is ready for this tab yet.", { domain: identity.domain });
    return null;
  }

  if (pendingSummaryVisitIds.has(session.visitId)) {
    setLastSummaryStatus("pending", "A summary task is already queued for this visit.", { domain: identity.domain });
    return null;
  }

  const visitEvents = await StorageUtils.getVisitEvents();
  let alreadySummarized = false;
  updateVisitEventInStore(visitEvents, session.visitId, (event) => {
    alreadySummarized = Boolean(event.summaryId);
  });
  if (alreadySummarized) {
    setLastSummaryStatus("exists", "This visit already has a summary task or result.", { domain: identity.domain });
    return null;
  }

  pendingSummaryVisitIds.add(session.visitId);
  try {
    const { record, dateKey } = await createSummaryRecordForTab(tab, settings, SUMMARY_STATUS.PENDING);
    setLastSummaryStatus("pending", "Summary task queued.", { domain: identity.domain, summaryId: record.id });
    scheduleSummaryTask({
      tabId: tab.id,
      url: identity.url,
      summaryId: record.id,
      dateKey,
      visitId: session.visitId
    });
    return record;
  } catch (error) {
    pendingSummaryVisitIds.delete(session.visitId);
    setLastSummaryStatus("error", error.message || "Failed to queue summary task.", { domain: identity.domain });
    await addDiagnosticLog({
      level: "error",
      priority: "high",
      source: "records",
      category: errorCategory(error, "program"),
      operation: "queue_summary_task",
      message: error.message || "Failed to queue summary task.",
      domain: identity.domain,
      url: identity.url,
      visitId: session.visitId,
      status: error.status || null,
      details: {
        diagnostic: error.diagnostic || null
      },
      error
    });
    throw error;
  }
}

async function maybeAutoSummarizeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) {
    return null;
  }

  await ensureOpenSessionForTab(tab);
  return maybeAutoSummarizeTab(tab, { silentUnsupported: true });
}

function dateRangeKeys(period, endDateKey) {
  const endTs = endDateKey ? new Date(`${endDateKey}T00:00:00`).getTime() : Date.now();
  const days = period === "month" ? 30 : period === "week" ? 7 : 1;
  const keys = [];

  for (let index = days - 1; index >= 0; index -= 1) {
    keys.push(TimeUtils.dateKeyFromTimestamp(endTs - index * 24 * 60 * 60 * 1000));
  }

  return keys;
}

function evidenceAwareAnalysisPrompt(prompt) {
  return [
    prompt,
    "",
    "Use the provided JSON as evidence. Be strict about evidence quality:",
    "- Separate statistical facts from content-supported conclusions and low-confidence guesses.",
    "- Treat pageSummaries with evidenceLevel=low or captureMethod=metadata_only as weak evidence only.",
    "- Do not infer page content from URL/title alone unless you label it as low confidence.",
    "- Include a short Data gaps section for blocked, low_content, metadata_only, or error captures.",
    "- Prefer concrete time/domain/page evidence over broad psychological claims."
  ].join("\n");
}

async function runAnalysis(period, endDateKey) {
  const startedAt = Date.now();
  setLastAnalysisStatus("running", `Running ${period} analysis.`, { period, endDateKey, startedAt });
  let report = null;
  let analysisModelConfig = null;
  try {
    const settings = await StorageUtils.getSettings();
    analysisModelConfig = settings.analysisModel;
    const keys = dateRangeKeys(period, endDateKey);
    const dailyStats = await rebuildAndStoreDailyStats();
    const visitEvents = await StorageUtils.getVisitEvents();
    const pageSummaries = await repairLegacySummaryCaptureMetadata();
    const analysisReports = await StorageUtils.getAnalysisReports();
    const prompt = period === "month"
      ? settings.analysisModel.monthlyPrompt
      : period === "week"
        ? settings.analysisModel.weeklyPrompt
        : settings.analysisModel.dailyPrompt;
    const payload = {
      period,
      dates: keys,
      dailyStats: Object.fromEntries(keys.map((key) => [key, dailyStats[key] || {}])),
      visitEvents: Object.fromEntries(keys.map((key) => [key, visitEvents[key] || []])),
      pageSummaries: Object.fromEntries(keys.map((key) => [key, pageSummaries[key] || []]))
    };
    const content = JSON.stringify(payload, null, 2).slice(0, 50000);
    setLastAnalysisStatus("calling_model", `Calling analysis model for ${period}.`, {
      period,
      endDateKey,
      startedAt,
      inputChars: content.length
    });
    const result = await callChatModel(
      settings.analysisModel,
      evidenceAwareAnalysisPrompt(prompt),
      content,
      {
        maxTokens: 4096,
        timeoutMs: ANALYSIS_MODEL_REQUEST_TIMEOUT_MS
      }
    );
    report = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      period,
      startDate: keys[0],
      endDate: keys[keys.length - 1],
      model: settings.analysisModel.model,
      prompt: evidenceAwareAnalysisPrompt(prompt),
      report: result.text,
      usage: result.usage
    };

    analysisReports[period] = analysisReports[period] || [];
    analysisReports[period].unshift(report);
    await StorageUtils.setAnalysisReports(analysisReports);

    const backup = {};
    try {
      const localAnalysis = await archiveAnalysisReportToLocal(report);
      backup.local = localAnalysis;
      report.backup = backup;
      await StorageUtils.setAnalysisReports(analysisReports);
      backup.records = {
        ...(backup.records || {}),
        local: await archiveDailyRecordsForDateKeys(keys)
      };
    } catch (error) {
      backup.local = {
        status: "error",
        error: error.message || "Local archive failed."
      };
      await addDiagnosticLog({
        level: "error",
        priority: "medium",
        source: "analysis",
        category: "storage",
        operation: "archive_analysis_local",
        message: error.message || "Local archive failed.",
        reportId: report.id,
        details: {
          period,
          startDate: report.startDate,
          endDate: report.endDate
        },
        error
      });
    }
    try {
      const remoteAnalysis = await backupAnalysisReportToWebdav(report);
      backup.remote = remoteAnalysis;
      backup.records = {
        ...(backup.records || {}),
        remote: await backupDailyRecordsForDateKeys(keys)
      };
    } catch (error) {
      backup.remote = {
        status: "error",
        error: error.message || "WebDAV backup failed."
      };
      await addDiagnosticLog({
        level: "error",
        priority: "medium",
        source: "analysis",
        category: settings.webdav.url ? "external" : "configuration",
        operation: "backup_analysis_webdav",
        message: error.message || "WebDAV backup failed.",
        reportId: report.id,
        endpoint: settings.webdav.url,
        status: error.status || null,
        details: {
          period,
          startDate: report.startDate,
          endDate: report.endDate,
          diagnostic: error.diagnostic || null
        },
        error
      });
    }
    report.backup = backup;
    await StorageUtils.setAnalysisReports(analysisReports);
    setLastAnalysisStatus("done", `${period} analysis completed.`, {
      period,
      endDateKey,
      startedAt,
      finishedAt: Date.now(),
      reportId: report.id
    });
    return report;
  } catch (error) {
    setLastAnalysisStatus("error", error.message || "Analysis failed.", {
      period,
      endDateKey,
      startedAt,
      finishedAt: Date.now(),
      reportId: report?.id || null
    });
    await addDiagnosticLog({
      level: "error",
      priority: errorPriority(error, "high"),
      source: "analysis",
      category: errorCategory(error, "program"),
      operation: "run_analysis",
      message: error.message || "Analysis failed.",
      reportId: report?.id || null,
      status: error.status || null,
      ...modelLogFields(analysisModelConfig || {}),
      details: {
        period,
        endDateKey,
        startedAt,
        finishedAt: Date.now(),
        diagnostic: error.diagnostic || null
      },
      error
    });
    throw error;
  }
}

function webdavHeaders(settings, contentType = null) {
  const headers = {};
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  if (settings.webdav.username || settings.webdav.password) {
    headers.Authorization = `Basic ${btoa(`${settings.webdav.username}:${settings.webdav.password}`)}`;
  }

  return headers;
}

function webdavBaseAndPath(settings) {
  return {
    baseUrl: settings.webdav.url.replace(/\/+$/, ""),
    basePath: (settings.webdav.backupPath || "browser-tracker").replace(/^\/+|\/+$/g, "")
  };
}

function datePartsFromKey(dateKey) {
  const [year = "0000", month = "00"] = String(dateKey || "").split("-");
  return { year, month };
}

function timeKeyFromTimestamp(timestamp) {
  const date = new Date(timestamp || Date.now());
  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
}

function localJoin(...parts) {
  return parts
    .filter((part) => String(part || "").trim())
    .map((part, index) => {
      const value = String(part);
      if (index === 0) {
        return value.replace(/[\\/]+$/g, "");
      }
      return value.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .join("/");
}

function cleanArchiveFolderName(value) {
  return String(value || "browser-tracker")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\./g, "")
    .trim() || "browser-tracker";
}

function localArchiveRoot(settings) {
  return cleanArchiveFolderName(settings.localArchive?.downloadsFolder);
}

function openLocalArchiveDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_ARCHIVE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LOCAL_ARCHIVE_STORE)) {
        request.result.createObjectStore(LOCAL_ARCHIVE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getDirectoryHandle() {
  const db = await openLocalArchiveDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LOCAL_ARCHIVE_STORE, "readonly");
    const request = transaction.objectStore(LOCAL_ARCHIVE_STORE).get(LOCAL_ARCHIVE_HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function archiveFolderPath(displayRoot, relativePath) {
  return localJoin(displayRoot, relativePath.split("/").slice(0, -1).join("/"));
}

function archiveResult(settings, mode, relativePath, backedUpAt = Date.now(), extra = {}) {
  const root = mode === "directory"
    ? settings.localArchive?.directoryName || "Selected folder"
    : `Downloads/${localArchiveRoot(settings)}`;
  return {
    status: extra.status || "done",
    mode,
    backedUpAt,
    relativePath,
    displayPath: localJoin(root, relativePath),
    folderPath: archiveFolderPath(root, relativePath),
    ...extra
  };
}

function dataUrlForText(text, contentType) {
  return `data:${contentType};charset=utf-8,${encodeURIComponent(text)}`;
}

async function writeDownloadArchiveFile(settings, relativePath, text, contentType) {
  const filename = localJoin(localArchiveRoot(settings), relativePath);
  const downloadId = await chrome.downloads.download({
    url: dataUrlForText(text, contentType),
    filename,
    conflictAction: "overwrite",
    saveAs: false
  });
  return archiveResult(settings, "downloads", relativePath, Date.now(), { downloadId });
}

async function writeFileToDirectory(rootHandle, relativePath, text) {
  const parts = relativePath.split("/").filter(Boolean);
  const fileName = parts.pop();
  let directory = rootHandle;

  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function writeDirectoryArchiveFile(settings, relativePath, text) {
  const handle = await getDirectoryHandle();
  if (!handle) {
    throw new Error("Local archive folder is not available.");
  }

  const permission = await handle.queryPermission?.({ mode: "readwrite" });
  if (permission && permission !== "granted") {
    throw new Error("Local archive folder permission is not granted.");
  }

  await writeFileToDirectory(handle, relativePath, text);
  return archiveResult(settings, "directory", relativePath);
}

async function writeLocalArchiveFile(relativePath, text, contentType) {
  const settings = await StorageUtils.getSettings();
  if (settings.localArchive?.mode === "directory") {
    try {
      return await writeDirectoryArchiveFile(settings, relativePath, text, contentType);
    } catch (error) {
      const fallback = await writeDownloadArchiveFile(settings, relativePath, text, contentType);
      return {
        ...fallback,
        status: "fallback",
        fallbackReason: error.message || "Directory archive failed."
      };
    }
  }

  return writeDownloadArchiveFile(settings, relativePath, text, contentType);
}

async function writeLocalArchiveJson(relativePath, payload) {
  return writeLocalArchiveFile(relativePath, JSON.stringify(payload, null, 2), "application/json");
}

async function writeLocalArchiveText(relativePath, text, contentType = "text/markdown") {
  return writeLocalArchiveFile(relativePath, text, contentType);
}

function dailyRecordRelativePath(dateKey) {
  const { year, month } = datePartsFromKey(dateKey);
  return `records/${year}/${month}/${dateKey}.json`;
}

function analysisReportRelativePath(report) {
  const { year, month } = datePartsFromKey(report.endDate);
  const id = String(report.id || "").replace(/[^a-z0-9-]/gi, "").slice(0, 8) || "report";
  const timeKey = timeKeyFromTimestamp(report.createdAt);
  const datePart = report.startDate === report.endDate
    ? report.endDate
    : `${report.startDate}_to_${report.endDate}`;
  return `analysis/${year}/${month}/${datePart}_${report.period}_${timeKey}_${id}.md`;
}

function remoteBackupLocation(settings, relativePath, backedUpAt = Date.now()) {
  const { baseUrl, basePath } = webdavBaseAndPath(settings);
  const remotePath = localJoin(basePath || "browser-tracker", relativePath);
  return {
    status: "done",
    backedUpAt,
    remotePath,
    remoteUrl: `${baseUrl}/${remotePath}`,
    relativePath
  };
}

function compactAnalysisReportsForDate(reports, dateKey) {
  const result = {};
  for (const [period, items] of Object.entries(reports || {})) {
    const matches = (items || [])
      .filter((report) => report.endDate === dateKey || TimeUtils.dateKeyFromTimestamp(report.createdAt) === dateKey)
      .map((report) => ({
        id: report.id,
        createdAt: report.createdAt,
        period: report.period,
        startDate: report.startDate,
        endDate: report.endDate,
        model: report.model,
        usage: report.usage || null,
        backup: report.backup || null
      }));
    if (matches.length) {
      result[period] = matches;
    }
  }
  return result;
}

async function collectBackupStores() {
  await checkpointActiveSession();
  await syncOpenSessionsWithTabs();
  await checkpointOpenSessions();
  return {
    dailyStats: await rebuildAndStoreDailyStats(),
    visitEvents: await StorageUtils.getVisitEvents(),
    pageSummaries: await StorageUtils.getPageSummaries(),
    analysisReports: await StorageUtils.getAnalysisReports(),
    settings: await StorageUtils.getSettings()
  };
}

async function buildDailyRecordArchive(dateKey, stores = null) {
  const data = stores || await collectBackupStores();

  return {
    exportedAt: Date.now(),
    schemaVersion: 3,
    archiveType: "daily_record",
    timezone: TimeUtils.systemTimeZone(),
    date: dateKey,
    dailyStats: data.dailyStats[dateKey] || {},
    visitEvents: data.visitEvents[dateKey] || [],
    pageSummaries: data.pageSummaries[dateKey] || [],
    analysisReports: compactAnalysisReportsForDate(data.analysisReports, dateKey),
    settings: sanitizeSettings(data.settings)
  };
}

function buildAnalysisMarkdown(report, backup = null) {
  const usage = report.usage?.total_tokens
    ? `${report.usage.total_tokens} tokens`
    : "not reported";
  const localPath = backup?.local?.displayPath || backup?.displayPath || "";
  const remotePath = backup?.remote?.remotePath || backup?.remotePath || "";
  return [
    "---",
    `id: ${report.id}`,
    `period: ${report.period}`,
    `startDate: ${report.startDate}`,
    `endDate: ${report.endDate}`,
    `createdAt: ${new Date(report.createdAt).toISOString()}`,
    `model: ${report.model || ""}`,
    `usage: ${usage}`,
    localPath ? `localPath: ${localPath}` : "",
    remotePath ? `remotePath: ${remotePath}` : "",
    "---",
    "",
    `# ${report.period[0].toUpperCase()}${report.period.slice(1)} Analysis`,
    "",
    `Date range: ${report.startDate} to ${report.endDate}`,
    "",
    report.report || ""
  ].filter((line) => line !== "").join("\n");
}

async function putWebdavJson(path, payload) {
  const settings = await StorageUtils.getSettings();
  if (!settings.webdav.url) {
    throw new Error("WebDAV URL is required.");
  }

  const { baseUrl } = webdavBaseAndPath(settings);
  const headers = webdavHeaders(settings, "application/json");
  await ensureWebdavDirectories(baseUrl, path, settings);

  const response = await fetch(`${baseUrl}/${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload, null, 2)
  });

  if (!response.ok) {
    throw await webdavResponseError("WebDAV backup failed", response, {
      stage: "put_json",
      method: "PUT",
      path,
      endpoint: `${baseUrl}/${path}`
    });
  }

  return {
    backedUpAt: Date.now(),
    path: `${baseUrl}/${path}`
  };
}

async function putWebdavText(path, text, contentType = "text/markdown; charset=utf-8") {
  const settings = await StorageUtils.getSettings();
  if (!settings.webdav.url) {
    throw new Error("WebDAV URL is required.");
  }

  const { baseUrl } = webdavBaseAndPath(settings);
  const headers = webdavHeaders(settings, contentType);
  await ensureWebdavDirectories(baseUrl, path, settings);

  const response = await fetch(`${baseUrl}/${path}`, {
    method: "PUT",
    headers,
    body: text
  });

  if (!response.ok) {
    throw await webdavResponseError("WebDAV backup failed", response, {
      stage: "put_text",
      method: "PUT",
      path,
      endpoint: `${baseUrl}/${path}`
    });
  }

  return {
    backedUpAt: Date.now(),
    path: `${baseUrl}/${path}`
  };
}

async function ensureWebdavDirectories(baseUrl, path, settings) {
  const parts = String(path).split("/").filter(Boolean).slice(0, -1);
  let cursor = "";
  const headers = webdavHeaders(settings);

  for (const part of parts) {
    cursor = cursor ? `${cursor}/${part}` : part;
    const response = await fetch(`${baseUrl}/${cursor}`, {
      method: "MKCOL",
      headers
    });

    if (!response.ok && response.status !== 405) {
      throw await webdavResponseError("WebDAV folder create failed", response, {
        stage: "ensure_directory",
        method: "MKCOL",
        path: cursor,
        endpoint: `${baseUrl}/${cursor}`
      });
    }
  }
}

async function backupDailyRecordToWebdav(dateKey, stores = null) {
  const settings = await StorageUtils.getSettings();
  if (!settings.webdav.url) {
    return { skipped: true, reason: "WebDAV URL is not configured.", dateKey };
  }

  const { basePath } = webdavBaseAndPath(settings);
  const relativePath = dailyRecordRelativePath(dateKey);
  const remotePath = localJoin(basePath || "browser-tracker", relativePath);
  const result = await putWebdavJson(remotePath, await buildDailyRecordArchive(dateKey, stores));
  return {
    ...remoteBackupLocation(settings, relativePath, result.backedUpAt),
    dateKey
  };
}

async function archiveDailyRecordToLocal(dateKey, stores = null) {
  const relativePath = dailyRecordRelativePath(dateKey);
  return {
    ...await writeLocalArchiveJson(relativePath, await buildDailyRecordArchive(dateKey, stores)),
    dateKey
  };
}

async function archiveDailyRecordsForDateKeys(dateKeys) {
  const results = [];
  const stores = await collectBackupStores();
  for (const dateKey of [...new Set(dateKeys || [])]) {
    results.push(await archiveDailyRecordToLocal(dateKey, stores));
  }
  return { skipped: false, results };
}

async function backupDailyRecordsForDateKeys(dateKeys) {
  const settings = await StorageUtils.getSettings();
  if (!settings.webdav.url) {
    return { skipped: true, reason: "WebDAV URL is not configured.", results: [] };
  }

  const results = [];
  const stores = await collectBackupStores();
  for (const dateKey of [...new Set(dateKeys || [])]) {
    results.push(await backupDailyRecordToWebdav(dateKey, stores));
  }
  return { skipped: false, results };
}

async function backupAnalysisReportToWebdav(report) {
  const settings = await StorageUtils.getSettings();
  if (!settings.webdav.url) {
    return { status: "skipped", skipped: true, reason: "WebDAV URL is not configured." };
  }

  const { basePath } = webdavBaseAndPath(settings);
  const relativePath = analysisReportRelativePath(report);
  const location = remoteBackupLocation(settings, relativePath);
  const remotePath = localJoin(basePath || "browser-tracker", relativePath);
  const result = await putWebdavText(remotePath, buildAnalysisMarkdown(report, location));
  return remoteBackupLocation(settings, relativePath, result.backedUpAt);
}

async function archiveAnalysisReportToLocal(report) {
  const relativePath = analysisReportRelativePath(report);
  return writeLocalArchiveText(relativePath, buildAnalysisMarkdown(report), "text/markdown");
}

function reportsForDateKeys(reports, dateKeys) {
  const allowed = new Set(dateKeys || []);
  return Object.values(reports || {})
    .flat()
    .filter((report) => allowed.has(report.endDate) || allowed.has(TimeUtils.dateKeyFromTimestamp(report.createdAt)));
}

function uniqueDateKeys(dateKeys) {
  return [...new Set((dateKeys || [])
    .map((dateKey) => String(dateKey || "").trim())
    .filter((dateKey) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey)))]
    .sort();
}

function currentWeekDateKeys() {
  const range = TimeUtils.weekRangeFromTimestamp(Date.now());
  const dateKeys = [];
  for (let cursor = range.startTs; cursor < range.endTs; cursor += 24 * 60 * 60 * 1000) {
    dateKeys.push(TimeUtils.dateKeyFromTimestamp(cursor));
  }
  return dateKeys;
}

async function backupDateKeys(dateKeys, options = {}) {
  const normalizedDateKeys = uniqueDateKeys(dateKeys);
  const settings = await StorageUtils.getSettings();
  const logSource = options.logSource || "settings";
  const operationPrefix = options.operationPrefix || "backup";

  const local = {};
  const remote = {};
  try {
    local.records = await archiveDailyRecordsForDateKeys(normalizedDateKeys);
  } catch (error) {
    local.records = { status: "error", error: error.message || "Local archive failed.", results: [] };
    await addDiagnosticLog({
      level: "error",
      priority: "medium",
      source: logSource,
      category: "storage",
      operation: `${operationPrefix}_records_local`,
      message: error.message || "Local archive failed.",
      details: { dateKeys: normalizedDateKeys, trigger: options.trigger || "" },
      error
    });
  }
  try {
    remote.records = await backupDailyRecordsForDateKeys(normalizedDateKeys);
  } catch (error) {
    remote.records = { status: "error", error: error.message || "WebDAV backup failed.", results: [] };
    await addDiagnosticLog({
      level: "error",
      priority: "medium",
      source: logSource,
      category: settings.webdav.url ? "external" : "configuration",
      operation: `${operationPrefix}_records_webdav`,
      message: error.message || "WebDAV backup failed.",
      endpoint: settings.webdav.url,
      status: error.status || null,
      details: {
        dateKeys: normalizedDateKeys,
        trigger: options.trigger || "",
        diagnostic: error.diagnostic || null
      },
      error
    });
  }

  const analysisReports = await StorageUtils.getAnalysisReports();
  local.analysis = [];
  remote.analysis = [];
  for (const report of reportsForDateKeys(analysisReports, normalizedDateKeys)) {
    report.backup = report.backup || {};
    try {
      report.backup.local = await archiveAnalysisReportToLocal(report);
      local.analysis.push(report.backup.local);
    } catch (error) {
      report.backup.local = { status: "error", error: error.message || "Local archive failed." };
      local.analysis.push(report.backup.local);
      await addDiagnosticLog({
        level: "error",
        priority: "medium",
        source: logSource,
        category: "storage",
        operation: `${operationPrefix}_analysis_local`,
        message: error.message || "Local archive failed.",
        reportId: report.id,
        details: {
          period: report.period,
          startDate: report.startDate,
          endDate: report.endDate,
          trigger: options.trigger || ""
        },
        error
      });
    }
    try {
      report.backup.remote = await backupAnalysisReportToWebdav(report);
      remote.analysis.push(report.backup.remote);
    } catch (error) {
      report.backup.remote = { status: "error", error: error.message || "WebDAV backup failed." };
      remote.analysis.push(report.backup.remote);
      await addDiagnosticLog({
        level: "error",
        priority: "medium",
        source: logSource,
        category: settings.webdav.url ? "external" : "configuration",
        operation: `${operationPrefix}_analysis_webdav`,
        message: error.message || "WebDAV backup failed.",
        reportId: report.id,
        endpoint: settings.webdav.url,
        status: error.status || null,
        details: {
          period: report.period,
          startDate: report.startDate,
          endDate: report.endDate,
          trigger: options.trigger || "",
          diagnostic: error.diagnostic || null
        },
        error
      });
    }
  }
  await StorageUtils.setAnalysisReports(analysisReports);

  return {
    backedUpAt: Date.now(),
    dateKeys: normalizedDateKeys,
    local,
    remote,
    records: remote.records,
    analysis: remote.analysis
  };
}

async function backupToWebdav() {
  return backupDateKeys(currentWeekDateKeys(), {
    logSource: "settings",
    operationPrefix: "backup",
    trigger: "manual"
  });
}

function dateKeyTimestamp(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.getTime();
}

function addDaysToDateKey(dateKey, days) {
  const timestamp = dateKeyTimestamp(dateKey);
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return TimeUtils.dateKeyFromTimestamp(date.getTime());
}

function yesterdayDateKey(now = Date.now()) {
  const date = new Date(now);
  return TimeUtils.dateKeyFromTimestamp(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime());
}

function dateKeyRange(startDateKey, endDateKey) {
  const dates = [];
  if (!dateKeyTimestamp(startDateKey) || !dateKeyTimestamp(endDateKey) || startDateKey > endDateKey) {
    return dates;
  }

  for (let cursor = startDateKey; cursor && cursor <= endDateKey; cursor = addDaysToDateKey(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

function maxDateKey(dateKeys) {
  const sorted = uniqueDateKeys(dateKeys);
  return sorted.length ? sorted[sorted.length - 1] : "";
}

function autoBackupDateKeys(state, now = Date.now()) {
  const yesterday = yesterdayDateKey(now);
  const pendingRemoteDateKeys = uniqueDateKeys(state?.pendingRemoteDateKeys || [])
    .filter((dateKey) => dateKey <= yesterday);
  const lastCoveredDateKey = dateKeyTimestamp(state?.lastCoveredDateKey)
    ? state.lastCoveredDateKey
    : "";
  const missedDateKeys = lastCoveredDateKey
    ? dateKeyRange(addDaysToDateKey(lastCoveredDateKey, 1), yesterday)
    : [yesterday];
  return uniqueDateKeys([...pendingRemoteDateKeys, ...missedDateKeys]);
}

function backupItemsHaveError(items) {
  return (items || []).some((item) => item?.status === "error");
}

function backupResultHasRemoteFailure(result) {
  return result?.remote?.records?.status === "error" || backupItemsHaveError(result?.remote?.analysis);
}

function backupResultError(result) {
  if (result?.local?.records?.status === "error") {
    return result.local.records.error || "Local archive failed.";
  }
  if (backupItemsHaveError(result?.local?.analysis)) {
    return "Some local analysis reports failed to archive.";
  }
  if (result?.remote?.records?.status === "error") {
    return result.remote.records.error || "WebDAV backup failed.";
  }
  if (backupItemsHaveError(result?.remote?.analysis)) {
    return "Some analysis reports failed to mirror to WebDAV.";
  }
  return "";
}

function successfulLocalRecordDateKeys(result) {
  if (result?.local?.records?.status === "error") {
    return [];
  }
  return uniqueDateKeys((result?.local?.records?.results || [])
    .filter((item) => item?.status !== "error")
    .map((item) => item.dateKey));
}

async function getAutoBackupStatus() {
  const settings = await StorageUtils.getSettings();
  const state = await StorageUtils.getAutoBackupState();
  return {
    enabled: settings.autoBackup?.enabled !== false,
    nextDateKeys: autoBackupDateKeys(state),
    ...state
  };
}

async function currentIdleState() {
  try {
    return await chrome.idle.queryState(IDLE_THRESHOLD_SECONDS);
  } catch {
    const state = await StorageUtils.getState();
    return state.idleState;
  }
}

async function maybeRunAutoBackup(trigger = "unknown", observedIdleState = "") {
  const settings = await StorageUtils.getSettings();
  if (settings.autoBackup?.enabled === false) {
    return { skipped: true, reason: "Auto backup is disabled." };
  }

  const idleState = observedIdleState || await currentIdleState();
  await StorageUtils.set({ idleState });
  if (!["idle", "locked"].includes(idleState)) {
    return { skipped: true, reason: "Browser is not idle." };
  }

  if (autoBackupRunning) {
    return { skipped: true, reason: "Auto backup is already running." };
  }

  const autoBackupState = await StorageUtils.getAutoBackupState();
  const now = Date.now();
  if (autoBackupState.lastAttemptAt && now - autoBackupState.lastAttemptAt < AUTO_BACKUP_MIN_INTERVAL_MS) {
    return { skipped: true, reason: "Auto backup was attempted recently." };
  }

  const dateKeys = autoBackupDateKeys(autoBackupState, now);
  if (!dateKeys.length) {
    return { skipped: true, reason: "No completed dates need backup." };
  }

  autoBackupRunning = true;
  await StorageUtils.setAutoBackupState({
    ...autoBackupState,
    lastAttemptAt: now,
    lastError: ""
  });

  try {
    const result = await backupDateKeys(dateKeys, {
      logSource: "auto_backup",
      operationPrefix: "auto_backup",
      trigger
    });
    const latestState = await StorageUtils.getAutoBackupState();
    const successfulLocalDates = successfulLocalRecordDateKeys(result);
    const attempted = new Set(dateKeys);
    let pendingRemoteDateKeys = uniqueDateKeys(latestState.pendingRemoteDateKeys)
      .filter((dateKey) => !attempted.has(dateKey) && dateKey <= yesterdayDateKey(now));
    if (backupResultHasRemoteFailure(result)) {
      pendingRemoteDateKeys = uniqueDateKeys([...pendingRemoteDateKeys, ...dateKeys]);
    }

    const coveredDateKey = maxDateKey([
      latestState.lastCoveredDateKey,
      ...successfulLocalDates
    ]);
    const nextState = {
      ...latestState,
      lastAttemptAt: now,
      lastCoveredDateKey: coveredDateKey || latestState.lastCoveredDateKey,
      pendingRemoteDateKeys,
      lastSuccessAt: successfulLocalDates.length ? Date.now() : latestState.lastSuccessAt,
      lastError: backupResultError(result)
    };
    await StorageUtils.setAutoBackupState(nextState);
    await addDiagnosticLog({
      level: nextState.lastError ? "error" : "info",
      priority: nextState.lastError ? "medium" : "low",
      source: "auto_backup",
      category: nextState.lastError ? "storage" : "configuration",
      operation: "auto_backup",
      message: nextState.lastError || "Auto backup completed.",
      details: {
        trigger,
        dateKeys,
        lastCoveredDateKey: nextState.lastCoveredDateKey,
        pendingRemoteDateKeys
      }
    });
    return {
      ...result,
      autoBackupState: nextState
    };
  } catch (error) {
    const latestState = await StorageUtils.getAutoBackupState();
    const nextState = {
      ...latestState,
      lastAttemptAt: now,
      lastError: error.message || "Auto backup failed."
    };
    await StorageUtils.setAutoBackupState(nextState);
    await addDiagnosticLog({
      level: "error",
      priority: "medium",
      source: "auto_backup",
      category: errorCategory(error, "storage"),
      operation: "auto_backup",
      message: error.message || "Auto backup failed.",
      status: error.status || null,
      details: {
        trigger,
        dateKeys,
        diagnostic: error.diagnostic || null
      },
      error
    });
    return { error: error.message || "Auto backup failed.", autoBackupState: nextState };
  } finally {
    autoBackupRunning = false;
  }
}

async function testLocalArchive() {
  const startedAt = Date.now();
  try {
    const result = await writeLocalArchiveJson(`system/test-local-archive-${Date.now()}.json`, {
      ok: true,
      testedAt: Date.now(),
      nonce: crypto.randomUUID()
    });
    await addDiagnosticLog({
      level: "info",
      priority: "medium",
      source: "settings",
      category: "configuration",
      operation: "test_local_archive",
      message: "Local archive test passed.",
      details: {
        durationMs: Date.now() - startedAt,
        mode: result.mode,
        status: result.status,
        relativePath: result.relativePath,
        displayPath: result.displayPath,
        fallbackReason: result.fallbackReason || ""
      }
    });
    return { ok: true, ...result };
  } catch (error) {
    await addDiagnosticLog({
      level: "error",
      priority: "high",
      source: "settings",
      category: "configuration",
      operation: "test_local_archive",
      message: error.message || "Local archive test failed.",
      details: {
        durationMs: Date.now() - startedAt
      },
      error
    });
    throw error;
  }
}

async function openLocalArchiveDownload(downloadId) {
  if (!Number.isInteger(downloadId)) {
    throw new Error("This local archive item cannot be opened directly. Copy the local path instead.");
  }
  await chrome.downloads.show(downloadId);
  return { ok: true };
}

async function testModel(target) {
  const settings = await StorageUtils.getSettings();
  const config = target === "analysis" ? settings.analysisModel : settings.summaryModel;
  const nonce = crypto.randomUUID();
  const startedAt = Date.now();
  const operation = target === "analysis" ? "test_analysis_model" : "test_summary_model";

  try {
    if (target === "analysis") {
      const result = await callChatModel(
        config,
        `Reply with exactly this token and no other text: ANALYSIS_TEST_${nonce}`,
        "Connectivity test.",
        { maxTokens: 32, fast: true, timeoutMs: 10 * 1000 }
      );
      if (result.text.trim() !== `ANALYSIS_TEST_${nonce}`) {
        const error = new Error("Analysis model returned text, but not the expected test response.");
        error.diagnostic = {
          responseTextExcerpt: result.text.slice(0, LOG_RESPONSE_EXCERPT_CHARS),
          expectedPrefix: "ANALYSIS_TEST"
        };
        throw error;
      }

      await addDiagnosticLog({
        level: "info",
        priority: "medium",
        source: "settings",
        category: "configuration",
        operation,
        message: "Analysis model test passed.",
        ...modelLogFields(config),
        details: {
          durationMs: Date.now() - startedAt,
          usage: result.usage || null,
          timeoutMs: 10 * 1000,
          maxTokens: 32
        }
      });
      return {
        ok: true,
        result: result.text,
        usage: result.usage
      };
    }

    const result = await callChatModel(
      config,
      `Return only this compact JSON and no markdown: {"summary":"SUMMARY_TEST_${nonce}","topics":["api-test"],"contentType":"other","intent":"test","keyPoints":["connectivity"],"confidence":1}`,
      "Connectivity test.",
      { json: true, maxTokens: 96, fast: true, timeoutMs: 10 * 1000 }
    );
    const resultText = result.text;
    const raw = parseJsonObjectFromText(resultText);
    if (!raw) {
      const error = new Error("Summary model did not return valid JSON.");
      error.diagnostic = {
        responseTextExcerpt: resultText.slice(0, LOG_RESPONSE_EXCERPT_CHARS),
        expectedShape: "summary/topics/contentType/intent/keyPoints/confidence"
      };
      throw error;
    }

    const parsed = normalizeSummaryJson(resultText);
    const hasRequiredShape =
      typeof raw.summary === "string" &&
      Array.isArray(raw.topics) &&
      typeof raw.contentType === "string" &&
      typeof raw.intent === "string" &&
      Array.isArray(raw.keyPoints) &&
      Object.prototype.hasOwnProperty.call(raw, "confidence");
    if (!hasRequiredShape || parsed.summary !== `SUMMARY_TEST_${nonce}` || parsed.intent !== "test") {
      const error = new Error("Summary model returned text, but not the expected structured test JSON.");
      error.diagnostic = {
        responseTextExcerpt: resultText.slice(0, LOG_RESPONSE_EXCERPT_CHARS),
        hasRequiredShape
      };
      throw error;
    }

    await addDiagnosticLog({
      level: "info",
      priority: "medium",
      source: "settings",
      category: "configuration",
      operation,
      message: "Summary model test passed.",
      ...modelLogFields(config),
      details: {
        durationMs: Date.now() - startedAt,
        usage: result.usage || null,
        timeoutMs: 10 * 1000,
        maxTokens: 96,
        jsonMode: true
      }
    });
    return {
      ok: true,
      result: resultText,
      usage: result.usage
    };
  } catch (error) {
    await addDiagnosticLog({
      level: "error",
      priority: "high",
      source: "settings",
      category: "configuration",
      operation,
      message: error.message || `${target} model test failed.`,
      ...modelLogFields(config),
      status: error.status || null,
      details: {
        durationMs: Date.now() - startedAt,
        target,
        diagnostic: error.diagnostic || null
      },
      error
    });
    throw error;
  }
}

async function webdavResponseError(message, response, diagnostic = {}) {
  let responseTextExcerpt = "";
  try {
    responseTextExcerpt = (await response.text()).slice(0, LOG_RESPONSE_EXCERPT_CHARS);
  } catch {
    responseTextExcerpt = "";
  }
  const error = new Error(`${message}: ${response.status} ${response.statusText}`);
  error.status = response.status;
  error.diagnostic = {
    ...diagnostic,
    status: response.status,
    statusText: response.statusText,
    responseTextExcerpt
  };
  return error;
}

async function testWebdav() {
  const settings = await StorageUtils.getSettings();
  const startedAt = Date.now();
  let context = {
    configured: Boolean(settings.webdav.url),
    baseUrl: "",
    testPath: "",
    testUrl: "",
    stage: "validate"
  };

  try {
    if (!settings.webdav.url) {
      const error = new Error("WebDAV URL is required.");
      error.diagnostic = { ...context };
      throw error;
    }

    const { baseUrl, basePath } = webdavBaseAndPath(settings);
    const testPath = `${basePath || "browser-tracker"}/browser-tracker-test-${Date.now()}.json`;
    const testUrl = `${baseUrl}/${testPath}`;
    const headers = webdavHeaders(settings);
    const nonce = crypto.randomUUID();
    const payload = { ok: true, nonce, testedAt: Date.now() };
    context = { ...context, baseUrl, testPath, testUrl };

    context.stage = "ensure_directories";
    await ensureWebdavDirectories(baseUrl, testPath, settings);

    context.stage = "put";
    const putResponse = await fetch(testUrl, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!putResponse.ok) {
      throw await webdavResponseError("WebDAV write test failed", putResponse, {
        ...context,
        method: "PUT"
      });
    }

    context.stage = "get";
    const getResponse = await fetch(testUrl, { method: "GET", headers });
    if (!getResponse.ok) {
      throw await webdavResponseError("WebDAV read test failed", getResponse, {
        ...context,
        method: "GET"
      });
    }

    const readText = await getResponse.text();
    let readPayload = null;
    try {
      readPayload = JSON.parse(readText);
    } catch (error) {
      throw attachDiagnostic(new Error("WebDAV read test returned non-JSON content."), {
        ...context,
        method: "GET",
        responseTextExcerpt: readText.slice(0, LOG_RESPONSE_EXCERPT_CHARS)
      });
    }

    if (readPayload?.nonce !== nonce) {
      throw attachDiagnostic(new Error("WebDAV read test returned different content than the uploaded test file."), {
        ...context,
        method: "GET",
        expectedNoncePresent: true,
        actualNoncePresent: Boolean(readPayload?.nonce)
      });
    }

    context.stage = "delete";
    const deleteResponse = await fetch(testUrl, { method: "DELETE", headers });
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      throw await webdavResponseError("WebDAV cleanup failed", deleteResponse, {
        ...context,
        method: "DELETE"
      });
    }

    await addDiagnosticLog({
      level: "info",
      priority: "medium",
      source: "settings",
      category: "configuration",
      operation: "test_webdav",
      message: "WebDAV test passed.",
      endpoint: testUrl,
      status: getResponse.status,
      details: {
        durationMs: Date.now() - startedAt,
        path: testPath,
        putStatus: putResponse.status,
        getStatus: getResponse.status,
        deleteStatus: deleteResponse.status
      }
    });
    return {
      ok: true,
      path: testPath,
      status: getResponse.status
    };
  } catch (error) {
    await addDiagnosticLog({
      level: "error",
      priority: "high",
      source: "settings",
      category: "configuration",
      operation: "test_webdav",
      message: error.message || "WebDAV test failed.",
      endpoint: context.testUrl || context.baseUrl || settings.webdav.url,
      status: error.status || null,
      details: {
        durationMs: Date.now() - startedAt,
        context,
        diagnostic: error.diagnostic || null
      },
      error
    });
    throw error;
  }
}

async function getSnapshot() {
  const currentState = await StorageUtils.getState();
  if (!currentState.activeSession || !Number.isInteger(currentState.focusedWindowId)) {
    await refreshFocusedSession();
  }

  await checkpointActiveSession();
  await syncOpenSessionsWithTabs();
  await checkpointOpenSessions();

  const state = await StorageUtils.getState();
  const dailyStats = await rebuildAndStoreDailyStats();
  const todayKey = TimeUtils.dateKeyFromTimestamp(Date.now());
  const today = dailyStats[todayKey] || {};
  const rows = dayRows(today);
  const totalActiveSeconds = rows.reduce((sum, row) => sum + row.activeSeconds, 0);
  const totalOpenSeconds = rows.reduce((sum, row) => sum + row.openSeconds, 0);

  return {
    activeSession: state.activeSession,
    dailyStats,
    idleState: state.idleState,
    openSessions: state.openSessions || {},
    today,
    todayKey,
    timezone: TimeUtils.systemTimeZone(),
    topSites: rows,
    totalActiveSeconds,
    totalOpenSeconds,
    totalSeconds: totalActiveSeconds,
    trackingPaused: state.trackingPaused
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await enqueueOperation(async () => {
    await setupContextMenus();
    await chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
    await chrome.alarms.create(CHECKPOINT_ALARM, { periodInMinutes: 1 });
    await hydrateOpenSessions();
    await refreshFocusedSession();
    await maybeAutoSummarizeActiveTab();
  });
});

chrome.runtime.onStartup.addListener(async () => {
  await enqueueOperation(async () => {
    await setupContextMenus();
    await chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
    await chrome.alarms.create(CHECKPOINT_ALARM, { periodInMinutes: 1 });
    await hydrateOpenSessions();
    await refreshFocusedSession();
    await maybeAutoSummarizeActiveTab();
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== IGNORE_DOMAIN_MENU) {
    return;
  }

  enqueueOperation(async () => {
    const identity = UrlUtils.getPageIdentity(info.pageUrl || tab?.url);
    if (!identity) {
      return;
    }

    await ignoreDomainAndSettle(identity.domain, tab?.id);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECKPOINT_ALARM) {
    enqueueOperation(async () => {
      await checkpointActiveSession();
      await syncOpenSessionsWithTabs();
      await checkpointOpenSessions();
      await maybeScreenshotFallbackActiveTab();
      await maybeRunAutoBackup("checkpoint_alarm");
    });
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await enqueueOperation(async () => {
    await beginOpenSessionForTab(tab);
  });
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await enqueueOperation(async () => {
    const state = await StorageUtils.getState();
    if (!Number.isInteger(state.focusedWindowId)) {
      await StorageUtils.set({ focusedWindowId: activeInfo.windowId });
    } else if (activeInfo.windowId !== state.focusedWindowId) {
      return;
    }

    await settleActiveSession();
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await beginSessionForTab(tab, activeInfo.windowId);
    await maybeAutoSummarizeTab(tab, { silentUnsupported: true });
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await enqueueOperation(async () => {
    if (changeInfo.url) {
      const state = await StorageUtils.getState();
      if (state.ignoredPageSessions?.[String(tabId)]) {
        const ignoredPageSessions = { ...(state.ignoredPageSessions || {}) };
        delete ignoredPageSessions[String(tabId)];
        await StorageUtils.set({ ignoredPageSessions });
      }
      await settleOpenSession(tabId, { nextTab: tab });
    } else if (changeInfo.status === "complete") {
      const state = await StorageUtils.getState();
      if (!state.openSessions?.[String(tabId)]) {
        await beginOpenSessionForTab(tab);
      }
    }

    if (!changeInfo.url && changeInfo.status !== "complete") {
      return;
    }

    if (changeInfo.status === "complete") {
      await maybeAutoSummarizeTab(tab, { silentUnsupported: true });
    }

    const state = await StorageUtils.getState();
    const isCurrentTab =
      state.activeSession?.tabId === tabId ||
      (tab.active && tab.windowId === state.focusedWindowId);

    if (!isCurrentTab) {
      return;
    }

    await settleActiveSession();
    await beginSessionForTab(tab, tab.windowId);
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await enqueueOperation(async () => {
    const state = await StorageUtils.getState();
    await settleOpenSession(tabId);
    if (state.ignoredPageSessions?.[String(tabId)]) {
      const ignoredPageSessions = { ...(state.ignoredPageSessions || {}) };
      delete ignoredPageSessions[String(tabId)];
      await StorageUtils.set({ ignoredPageSessions });
    }
    if (state.activeSession?.tabId === tabId) {
      await refreshFocusedSession();
    }
  });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await enqueueOperation(async () => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      await settleActiveSession();
      await StorageUtils.set({ focusedWindowId: windowId, activeSession: null });
      return;
    }

    await switchToFocusedTab(windowId);
  });
});

chrome.idle.onStateChanged.addListener(async (idleState) => {
  await enqueueOperation(async () => {
    if (idleState === "locked") {
      await settleActiveSession();
      await StorageUtils.set({ idleState, activeSession: null });
      await maybeRunAutoBackup("idle_locked", idleState);
      return;
    }

    await StorageUtils.set({ idleState });
    await refreshFocusedSession();
    if (idleState === "idle") {
      await maybeRunAutoBackup("idle_state", idleState);
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (["GET_SETTINGS", "SAVE_SETTINGS", "GET_AUTO_BACKUP_STATUS", "TEST_MODEL", "TEST_LOCAL_ARCHIVE", "OPEN_LOCAL_ARCHIVE", "TEST_WEBDAV", "RUN_ANALYSIS", "GET_ANALYSIS_DATA", "GET_LOGS", "ADD_LOG", "CLEAR_LOGS", "EXPORT_LOGS"].includes(message?.type)) {
    (async () => {
      if (message.type === "GET_LOGS") {
        sendResponse({
          logs: await StorageUtils.getDiagnosticLogs(),
          maxLogs: MAX_DIAGNOSTIC_LOGS
        });
        return;
      }

      if (message.type === "ADD_LOG") {
        sendResponse({
          log: await addDiagnosticLog({
            source: "ui",
            ...(message.entry || {})
          })
        });
        return;
      }

      if (message.type === "CLEAR_LOGS") {
        await StorageUtils.clearDiagnosticLogs();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "EXPORT_LOGS") {
        sendResponse(await exportDiagnosticLogs());
        return;
      }

      if (message.type === "GET_SETTINGS") {
        sendResponse(await StorageUtils.getSettings());
        return;
      }

      if (message.type === "SAVE_SETTINGS") {
        await StorageUtils.setSettings(message.settings || {});
        sendResponse(await StorageUtils.getSettings());
        return;
      }

      if (message.type === "GET_AUTO_BACKUP_STATUS") {
        sendResponse(await getAutoBackupStatus());
        return;
      }

      if (message.type === "TEST_MODEL") {
        sendResponse(await testModel(message.target || "summary"));
        return;
      }

      if (message.type === "TEST_WEBDAV") {
        sendResponse(await testWebdav());
        return;
      }

      if (message.type === "TEST_LOCAL_ARCHIVE") {
        sendResponse(await testLocalArchive());
        return;
      }

      if (message.type === "OPEN_LOCAL_ARCHIVE") {
        sendResponse(await openLocalArchiveDownload(message.downloadId));
        return;
      }

      if (message.type === "RUN_ANALYSIS") {
        sendResponse(await runAnalysis(message.period || "day", message.endDateKey));
        return;
      }

      if (message.type === "GET_ANALYSIS_DATA") {
        sendResponse({
          dailyStats: await StorageUtils.getDailyStats(),
          analysisReports: await StorageUtils.getAnalysisReports(),
          pageSummaries: await repairLegacySummaryCaptureMetadata(),
          visitEvents: await StorageUtils.getVisitEvents(),
          analysisStatus: lastAnalysisStatus
        });
      }
    })().catch(async (error) => {
      if (!["TEST_MODEL", "TEST_WEBDAV", "TEST_LOCAL_ARCHIVE", "RUN_ANALYSIS"].includes(message?.type)) {
        await addDiagnosticLog({
          level: "error",
          priority: "high",
          source: "runtime",
          category: "program",
          operation: `message_${String(message?.type || "unknown").toLowerCase()}`,
          message: error.message || "Message handler failed.",
          error
        });
      }
      sendResponse({ error: error.message || "Operation failed" });
    });

    return true;
  }

  enqueueOperation(async () => {
    if (message?.type === "GET_SNAPSHOT") {
      sendResponse(await getSnapshot());
      return;
    }

    if (message?.type === "GET_SETTINGS") {
      sendResponse(await StorageUtils.getSettings());
      return;
    }

    if (message?.type === "SAVE_SETTINGS") {
      await StorageUtils.setSettings(message.settings || {});
      sendResponse(await StorageUtils.getSettings());
      return;
    }

    if (message?.type === "IGNORE_DOMAIN") {
      const ignoredDomains = await ignoreDomainAndSettle(message.domain, message.tabId);
      sendResponse({ ignoredDomains });
      return;
    }

    if (message?.type === "IGNORE_CURRENT_VISIT") {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      sendResponse(await ignoreCurrentVisit(tab));
      return;
    }

    if (message?.type === "EXPORT_FULL_DATA") {
      sendResponse(await exportFullData());
      return;
    }

    if (message?.type === "BACKUP_WEBDAV") {
      sendResponse(await backupToWebdav());
      return;
    }

    if (message?.type === "TEST_MODEL") {
      sendResponse(await testModel(message.target || "summary"));
      return;
    }

    if (message?.type === "TEST_WEBDAV") {
      sendResponse(await testWebdav());
      return;
    }

    if (message?.type === "TEST_LOCAL_ARCHIVE") {
      sendResponse(await testLocalArchive());
      return;
    }

    if (message?.type === "OPEN_LOCAL_ARCHIVE") {
      sendResponse(await openLocalArchiveDownload(message.downloadId));
      return;
    }

    if (message?.type === "SUMMARIZE_ACTIVE_TAB") {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      sendResponse(await summarizeTab(tab));
      return;
    }

    if (message?.type === "RUN_ANALYSIS") {
      sendResponse(await runAnalysis(message.period || "day", message.endDateKey));
      return;
    }

    if (message?.type === "GET_ANALYSIS_DATA") {
      sendResponse({
        dailyStats: await StorageUtils.getDailyStats(),
        analysisReports: await StorageUtils.getAnalysisReports(),
        pageSummaries: await repairLegacySummaryCaptureMetadata(),
        visitEvents: await StorageUtils.getVisitEvents(),
        analysisStatus: lastAnalysisStatus
      });
      return;
    }

    if (message?.type === "GET_RECORDS_DATA") {
      await checkpointActiveSession();
      await syncOpenSessionsWithTabs();
      await checkpointOpenSessions();
      const dailyStats = await rebuildAndStoreDailyStats();
      const settings = await StorageUtils.getSettings();
      const pageSummaries = await repairLegacySummaryCaptureMetadata();
      sendResponse({
        dailyStats,
        visitEvents: await StorageUtils.getVisitEvents(),
        pageSummaries,
        analysisReports: await StorageUtils.getAnalysisReports(),
        summaryDiagnostics: {
          autoSummarize: Boolean(settings.capture.autoSummarize),
          modelConfigured: Boolean((settings.summaryModel.endpoint || buildChatCompletionsEndpoint(settings.summaryModel.baseUrl)) && settings.summaryModel.model),
          lastSummaryStatus
        },
        timezone: TimeUtils.systemTimeZone(),
        settings: sanitizeSettings(settings)
      });
      return;
    }

    if (message?.type === "SET_TRACKING_PAUSED") {
      if (message.paused) {
        await settleActiveSession();
        await checkpointOpenSessions({ keepRunning: false });
        await StorageUtils.set({ trackingPaused: true, activeSession: null, openSessions: {} });
      } else {
        await StorageUtils.set({ trackingPaused: false });
        await hydrateOpenSessions();
        await refreshFocusedSession();
      }

      sendResponse(await getSnapshot());
      return;
    }

    if (message?.type === "CLEAR_DATE") {
      await checkpointActiveSession();
      await checkpointOpenSessions();
      const dailyStats = await StorageUtils.getDailyStats();
      const visitEvents = await StorageUtils.getVisitEvents();
      const pageSummaries = await StorageUtils.getPageSummaries();
      delete dailyStats[message.dateKey];
      delete visitEvents[message.dateKey];
      delete pageSummaries[message.dateKey];
      await StorageUtils.setDailyStats(dailyStats);
      await StorageUtils.setVisitEvents(visitEvents);
      await StorageUtils.setPageSummaries(pageSummaries);
      sendResponse(await getSnapshot());
      return;
    }

    sendResponse({ error: "Unknown message type" });
  }).catch((error) => {
    sendResponse({ error: error.message || "Operation failed" });
  });

  return true;
});
