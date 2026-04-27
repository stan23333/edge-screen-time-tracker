importScripts("utils/time.js", "utils/url.js", "utils/storage.js");

const IDLE_THRESHOLD_SECONDS = 300;
const CHECKPOINT_ALARM = "checkpoint-active-session";
const SUSPEND_GAP_MS = 10 * 60 * 1000;
const SCREENSHOT_FALLBACK_INTERVAL_MS = 10 * 60 * 1000;
const MODEL_REQUEST_TIMEOUT_MS = 15 * 1000;
const ANALYSIS_MODEL_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_SUMMARY_TEXT_CHARS = 200;
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
let operationQueue = Promise.resolve();
let summaryQueue = Promise.resolve();
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
  operationQueue = next.catch((error) => {
    console.error("Tracker operation failed", error);
  });
  return next;
}

function enqueueSummaryOperation(task) {
  const next = summaryQueue.then(task, task);
  summaryQueue = next.catch((error) => {
    console.error("Summary operation failed", error);
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

async function callChatModel(config, prompt, content, { json = false, maxTokens = null, fast = false, timeoutMs = MODEL_REQUEST_TIMEOUT_MS } = {}) {
  const endpoints = chatCompletionEndpoints(config);
  if (!endpoints.length || !config?.model) {
    throw new Error("Model base URL and model are required.");
  }
  if (!config.apiKey && !isLocalModelConfig(config)) {
    throw new Error("Model API key is required.");
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
  let response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  }, timeoutMs);

  if (!response.ok && body.response_format && isSiliconFlowConfig(config) && [400, 422].includes(response.status)) {
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(fallbackBody)
    }, timeoutMs);
  }

  if (!response.ok) {
    const error = new Error(await modelErrorMessage(response, endpoint));
    error.status = response.status;
    throw error;
  }

  return response.json();
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

async function modelErrorMessage(response, endpoint = "") {
  let detail = "";
  try {
    const text = await response.text();
    if (text) {
      detail = text.slice(0, 500);
    }
  } catch {
    detail = "";
  }

  return `Model request failed${endpoint ? ` at ${endpoint}` : ""}: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`;
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
  try {
    const settings = await StorageUtils.getSettings();
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
    try {
      report.backup = await backupWeeksForDateKeys(keys);
    } catch (error) {
      report.backup = {
        skipped: false,
        error: error.message || "WebDAV backup failed."
      };
    }
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

function weeklyArchivePath(basePath, weekKey) {
  const root = basePath && !/\.json$/i.test(basePath) ? basePath : "browser-tracker";
  return `${root}/weeks/${weekKey}.json`;
}

function filterObjectByKeys(source, keys, fallback) {
  return Object.fromEntries(keys.map((key) => [key, source?.[key] || fallback]));
}

function analysisReportsForWeek(reports, weekRange) {
  const start = weekRange.startTs;
  const end = weekRange.endTs;
  const result = {};

  for (const [period, items] of Object.entries(reports || {})) {
    result[period] = (items || []).filter((report) => report.createdAt >= start && report.createdAt < end);
  }

  return result;
}

async function buildWeeklyArchive(weekKey, rangeTimestamp = Date.now()) {
  await checkpointActiveSession();
  await syncOpenSessionsWithTabs();
  await checkpointOpenSessions();
  const dailyStats = await rebuildAndStoreDailyStats();
  const visitEvents = await StorageUtils.getVisitEvents();
  const pageSummaries = await StorageUtils.getPageSummaries();
  const analysisReports = await StorageUtils.getAnalysisReports();
  const settings = await StorageUtils.getSettings();
  const range = TimeUtils.weekRangeFromTimestamp(rangeTimestamp);
  const weekDates = [];

  for (let cursor = range.startTs; cursor < range.endTs; cursor += 24 * 60 * 60 * 1000) {
    weekDates.push(TimeUtils.dateKeyFromTimestamp(cursor));
  }

  return {
    exportedAt: Date.now(),
    schemaVersion: 2,
    archiveType: "weekly",
    timezone: TimeUtils.systemTimeZone(),
    weekKey,
    startDate: range.startDate,
    endDate: range.endDate,
    dailyStats: filterObjectByKeys(dailyStats, weekDates, {}),
    visitEvents: filterObjectByKeys(visitEvents, weekDates, []),
    pageSummaries: filterObjectByKeys(pageSummaries, weekDates, []),
    analysisReports: analysisReportsForWeek(analysisReports, range),
    settings: sanitizeSettings(settings)
  };
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
    throw new Error(`WebDAV backup failed: ${response.status} ${response.statusText}`);
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
      throw new Error(`WebDAV folder create failed: ${response.status} ${response.statusText}`);
    }
  }
}

async function backupWeekToWebdav(weekKey, rangeTimestamp = Date.now()) {
  const settings = await StorageUtils.getSettings();
  const { basePath } = webdavBaseAndPath(settings);
  const path = weeklyArchivePath(basePath, weekKey);
  return putWebdavJson(path, await buildWeeklyArchive(weekKey, rangeTimestamp));
}

async function backupWeeksForDateKeys(dateKeys) {
  const settings = await StorageUtils.getSettings();
  if (!settings.webdav.url) {
    return { skipped: true, reason: "WebDAV URL is not configured." };
  }

  const weekMap = new Map();
  for (const dateKey of dateKeys || []) {
    const timestamp = new Date(`${dateKey}T00:00:00`).getTime();
    weekMap.set(TimeUtils.weekKeyFromTimestamp(timestamp), timestamp);
  }
  const results = [];
  for (const [weekKey, timestamp] of weekMap.entries()) {
    results.push(await backupWeekToWebdav(weekKey, timestamp));
  }
  return { skipped: false, results };
}

async function backupToWebdav() {
  const weekKey = TimeUtils.weekKeyFromTimestamp(Date.now());
  return backupWeekToWebdav(weekKey);
}

async function testModel(target) {
  const settings = await StorageUtils.getSettings();
  const config = target === "analysis" ? settings.analysisModel : settings.summaryModel;
  const nonce = crypto.randomUUID();

  if (target === "analysis") {
    const result = await callChatModel(
      config,
      `Reply with exactly this token and no other text: ANALYSIS_TEST_${nonce}`,
      "Connectivity test.",
      { maxTokens: 32, fast: true, timeoutMs: 10 * 1000 }
    );
    if (result.text.trim() !== `ANALYSIS_TEST_${nonce}`) {
      throw new Error("Analysis model returned text, but not the expected test response.");
    }

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
    throw new Error("Summary model did not return valid JSON.");
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
    throw new Error("Summary model returned text, but not the expected structured test JSON.");
  }

  return {
    ok: true,
    result: resultText,
    usage: result.usage
  };
}

async function testWebdav() {
  const settings = await StorageUtils.getSettings();
  if (!settings.webdav.url) {
    throw new Error("WebDAV URL is required.");
  }

  const headers = {};
  if (settings.webdav.username || settings.webdav.password) {
    headers.Authorization = `Basic ${btoa(`${settings.webdav.username}:${settings.webdav.password}`)}`;
  }

  const baseUrl = settings.webdav.url.replace(/\/+$/, "");
  const testUrl = `${baseUrl}/browser-tracker-test-${Date.now()}.json`;
  const nonce = crypto.randomUUID();
  const payload = { ok: true, nonce, testedAt: Date.now() };
  const putResponse = await fetch(testUrl, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!putResponse.ok) {
    throw new Error(`WebDAV write test failed: ${putResponse.status} ${putResponse.statusText}`);
  }

  const getResponse = await fetch(testUrl, { method: "GET", headers });
  if (!getResponse.ok) {
    throw new Error(`WebDAV read test failed: ${getResponse.status} ${getResponse.statusText}`);
  }

  const readText = await getResponse.text();
  let readPayload = null;
  try {
    readPayload = JSON.parse(readText);
  } catch {
    throw new Error("WebDAV read test returned non-JSON content.");
  }

  if (readPayload?.nonce !== nonce) {
    throw new Error("WebDAV read test returned different content than the uploaded test file.");
  }

  const deleteResponse = await fetch(testUrl, { method: "DELETE", headers });
  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    throw new Error(`WebDAV cleanup failed: ${deleteResponse.status} ${deleteResponse.statusText}`);
  }

  return {
    ok: true,
    status: getResponse.status
  };
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
      return;
    }

    await StorageUtils.set({ idleState });
    await refreshFocusedSession();
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (["GET_SETTINGS", "SAVE_SETTINGS", "TEST_MODEL", "TEST_WEBDAV", "RUN_ANALYSIS", "GET_ANALYSIS_DATA"].includes(message?.type)) {
    (async () => {
      if (message.type === "GET_SETTINGS") {
        sendResponse(await StorageUtils.getSettings());
        return;
      }

    if (message.type === "SAVE_SETTINGS") {
      await StorageUtils.setSettings(message.settings || {});
      sendResponse(await StorageUtils.getSettings());
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
    })().catch((error) => {
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
