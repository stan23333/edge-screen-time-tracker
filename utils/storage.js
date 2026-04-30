(function attachStorageUtils(global) {
  const MAX_DIAGNOSTIC_LOGS = 1000;

  const DEFAULT_STATE = {
    activeSession: null,
    focusedWindowId: null,
    idleState: "active",
    ignoredPageSessions: {},
    lastHeartbeatTs: 0,
    openSessions: {},
    trackingPaused: false
  };

  const DEFAULT_SETTINGS = {
    summaryModel: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      endpoint: "",
      apiKey: "",
      model: "",
      prompt: "Summarize this browsing page. Return only valid JSON matching this schema: {\"summary\":\"string\",\"topics\":[\"string\"],\"contentType\":\"article|video|tool|search|social|docs|other\",\"intent\":\"string\",\"keyPoints\":[\"string\"],\"confidence\":0.0}. Do not include markdown."
    },
    analysisModel: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      endpoint: "",
      apiKey: "",
      model: "",
      dailyPrompt: "Analyze my browsing behavior for the selected day. Summarize themes, time patterns, attention patterns, and possible self-insights.",
      weeklyPrompt: "Analyze my browsing behavior for the selected week. Summarize repeated themes, time patterns, attention patterns, and possible self-insights.",
      monthlyPrompt: "Analyze my browsing behavior for the selected month. Summarize long-term themes, time patterns, attention patterns, and possible self-insights."
    },
    webdav: {
      url: "",
      username: "",
      password: "",
      backupPath: "browser-tracker"
    },
    localArchive: {
      mode: "",
      directoryName: "",
      directoryGrantedAt: 0
    },
    autoBackup: {
      enabled: true
    },
    capture: {
      autoSummarize: true,
      autoSummarizeTouched: false,
      maxContentChars: 12000,
      screenshotFallbackEnabled: true,
      screenshotAuthorizedDomains: [],
      screenshotPromptedDomains: {},
      screenshotLastCaptureByDomain: {}
    },
    ignoredDomains: []
  };

  const DEFAULT_AUTO_BACKUP_STATE = {
    lastCoveredDateKey: "",
    pendingRemoteDateKeys: [],
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    lastError: ""
  };

  const ARCHIVE_STATUSES = new Set(["pending", "done", "skipped", "missing", "deleted", "error"]);

  const DEFAULT_ARCHIVE_INDEX = {
    version: 1,
    updatedAt: 0,
    entries: {}
  };

  const DEFAULT_ARCHIVE_LAST_RUN = {
    at: 0,
    trigger: "",
    summary: {
      done: 0,
      skipped: 0,
      pending: 0,
      error: 0,
      deleted: 0,
      missing: 0
    },
    results: []
  };

  function get(keys) {
    return chrome.storage.local.get(keys);
  }

  function set(values) {
    return chrome.storage.local.set(values);
  }

  async function getState() {
    const state = await get(DEFAULT_STATE);
    return {
      ...DEFAULT_STATE,
      ...state
    };
  }

  async function getDailyStats() {
    const { dailyStats = {} } = await get({ dailyStats: {} });
    return dailyStats;
  }

  async function setDailyStats(dailyStats) {
    await set({ dailyStats });
  }

  function mergeSettings(settings) {
    const localArchive = settings?.localArchive || {};
    const hasDirectoryArchive = localArchive.mode === "directory"
      && Boolean(localArchive.directoryName || localArchive.directoryGrantedAt);

    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      summaryModel: {
        ...DEFAULT_SETTINGS.summaryModel,
        ...(settings?.summaryModel || {})
      },
      analysisModel: {
        ...DEFAULT_SETTINGS.analysisModel,
        ...(settings?.analysisModel || {})
      },
      webdav: {
        ...DEFAULT_SETTINGS.webdav,
        ...(settings?.webdav || {})
      },
      localArchive: {
        ...DEFAULT_SETTINGS.localArchive,
        mode: hasDirectoryArchive ? "directory" : "",
        directoryName: hasDirectoryArchive ? String(localArchive.directoryName || "Selected folder").trim() || "Selected folder" : "",
        directoryGrantedAt: hasDirectoryArchive ? Math.max(0, Math.floor(localArchive.directoryGrantedAt || 0)) : 0
      },
      autoBackup: {
        ...DEFAULT_SETTINGS.autoBackup,
        ...(settings?.autoBackup || {}),
        enabled: settings?.autoBackup?.enabled === false ? false : true
      },
      capture: {
        ...DEFAULT_SETTINGS.capture,
        ...(settings?.capture || {}),
        autoSummarize: settings?.capture?.autoSummarizeTouched
          ? Boolean(settings?.capture?.autoSummarize)
          : true,
        screenshotFallbackEnabled: settings?.capture?.screenshotFallbackEnabled === false ? false : true,
        screenshotAuthorizedDomains: Array.isArray(settings?.capture?.screenshotAuthorizedDomains)
          ? settings.capture.screenshotAuthorizedDomains
          : [],
        screenshotPromptedDomains: settings?.capture?.screenshotPromptedDomains && typeof settings.capture.screenshotPromptedDomains === "object"
          ? settings.capture.screenshotPromptedDomains
          : {},
        screenshotLastCaptureByDomain: settings?.capture?.screenshotLastCaptureByDomain && typeof settings.capture.screenshotLastCaptureByDomain === "object"
          ? settings.capture.screenshotLastCaptureByDomain
          : {}
      },
      ignoredDomains: Array.isArray(settings?.ignoredDomains) ? settings.ignoredDomains : []
    };
  }

  function mergeAutoBackupState(state) {
    const lastCoveredDateKey = safeText(state?.lastCoveredDateKey);
    return {
      ...DEFAULT_AUTO_BACKUP_STATE,
      ...(state || {}),
      lastCoveredDateKey: /^\d{4}-\d{2}-\d{2}$/.test(lastCoveredDateKey) ? lastCoveredDateKey : "",
      pendingRemoteDateKeys: Array.isArray(state?.pendingRemoteDateKeys)
        ? [...new Set(state.pendingRemoteDateKeys
          .map((dateKey) => safeText(dateKey))
          .filter((dateKey) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey)))].sort()
        : [],
      lastAttemptAt: Number.isFinite(Number(state?.lastAttemptAt)) ? Number(state.lastAttemptAt) : 0,
      lastSuccessAt: Number.isFinite(Number(state?.lastSuccessAt)) ? Number(state.lastSuccessAt) : 0,
      lastError: safeText(state?.lastError)
    };
  }

  function normalizeArchiveStatus(status, fallback = "pending") {
    const value = safeText(status, fallback);
    return ARCHIVE_STATUSES.has(value) ? value : fallback;
  }

  function normalizeArchiveSide(side = {}) {
    return {
      status: normalizeArchiveStatus(side.status),
      displayPath: safeText(side.displayPath),
      folderPath: safeText(side.folderPath),
      relativePath: safeText(side.relativePath),
      remotePath: safeText(side.remotePath),
      remoteUrl: safeText(side.remoteUrl),
      backedUpAt: Number.isFinite(Number(side.backedUpAt)) ? Number(side.backedUpAt) : 0,
      deletedAt: Number.isFinite(Number(side.deletedAt)) ? Number(side.deletedAt) : 0,
      updatedAt: Number.isFinite(Number(side.updatedAt)) ? Number(side.updatedAt) : 0,
      error: safeText(side.error),
      reason: safeText(side.reason)
    };
  }

  function normalizeArchiveEntry(entry = {}) {
    const now = Date.now();
    const kind = safeText(entry.kind);
    const id = safeText(entry.id) || `${kind || "archive"}:${safeText(entry.reportId || entry.dateKey) || now}`;
    return {
      id,
      kind: kind === "analysis" ? "analysis" : "record",
      title: safeText(entry.title),
      dateKey: safeText(entry.dateKey),
      reportId: safeText(entry.reportId),
      period: safeText(entry.period),
      contentType: safeText(entry.contentType),
      relativePath: safeText(entry.relativePath),
      createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : now,
      updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : now,
      local: normalizeArchiveSide(entry.local || {}),
      remote: normalizeArchiveSide(entry.remote || {})
    };
  }

  function mergeArchiveIndex(index = {}) {
    const entries = {};
    for (const [key, entry] of Object.entries(index?.entries || {})) {
      const normalized = normalizeArchiveEntry({ id: key, ...entry });
      entries[normalized.id] = normalized;
    }

    return {
      version: 1,
      updatedAt: Number.isFinite(Number(index?.updatedAt)) ? Number(index.updatedAt) : 0,
      entries
    };
  }

  function mergeArchiveLastRun(run = {}) {
    const summary = {
      ...DEFAULT_ARCHIVE_LAST_RUN.summary,
      ...(run?.summary || {})
    };
    for (const key of Object.keys(summary)) {
      summary[key] = Number.isFinite(Number(summary[key])) ? Number(summary[key]) : 0;
    }
    return {
      ...DEFAULT_ARCHIVE_LAST_RUN,
      ...(run || {}),
      at: Number.isFinite(Number(run?.at)) ? Number(run.at) : 0,
      trigger: safeText(run?.trigger),
      summary,
      results: Array.isArray(run?.results) ? run.results : []
    };
  }

  async function getSettings() {
    const { settings = DEFAULT_SETTINGS } = await get({ settings: DEFAULT_SETTINGS });
    return mergeSettings(settings);
  }

  async function setSettings(settings) {
    await set({ settings: mergeSettings(settings) });
  }

  async function getVisitEvents() {
    const { visitEvents = {} } = await get({ visitEvents: {} });
    return visitEvents;
  }

  async function setVisitEvents(visitEvents) {
    await set({ visitEvents });
  }

  async function getPageSummaries() {
    const { pageSummaries = {} } = await get({ pageSummaries: {} });
    return pageSummaries;
  }

  async function setPageSummaries(pageSummaries) {
    await set({ pageSummaries });
  }

  async function getAnalysisReports() {
    const { analysisReports = {} } = await get({ analysisReports: {} });
    return analysisReports;
  }

  async function setAnalysisReports(analysisReports) {
    await set({ analysisReports });
  }

  async function getAutoBackupState() {
    const { autoBackupState = DEFAULT_AUTO_BACKUP_STATE } = await get({ autoBackupState: DEFAULT_AUTO_BACKUP_STATE });
    return mergeAutoBackupState(autoBackupState);
  }

  async function setAutoBackupState(autoBackupState) {
    await set({ autoBackupState: mergeAutoBackupState(autoBackupState) });
  }

  async function getArchiveIndex() {
    const { archiveIndex = DEFAULT_ARCHIVE_INDEX } = await get({ archiveIndex: DEFAULT_ARCHIVE_INDEX });
    return mergeArchiveIndex(archiveIndex);
  }

  async function setArchiveIndex(archiveIndex) {
    await set({ archiveIndex: mergeArchiveIndex(archiveIndex) });
  }

  async function getArchiveLastRun() {
    const { archiveLastRun = DEFAULT_ARCHIVE_LAST_RUN } = await get({ archiveLastRun: DEFAULT_ARCHIVE_LAST_RUN });
    return mergeArchiveLastRun(archiveLastRun);
  }

  async function setArchiveLastRun(archiveLastRun) {
    await set({ archiveLastRun: mergeArchiveLastRun(archiveLastRun) });
  }

  function safeText(value, fallback = "") {
    return String(value ?? fallback).trim();
  }

  function normalizeDiagnosticLog(entry = {}) {
    const now = Date.now();
    return {
      id: safeText(entry.id) || (global.crypto?.randomUUID ? crypto.randomUUID() : `${now}-${Math.random().toString(16).slice(2)}`),
      createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : now,
      level: safeText(entry.level, "info") || "info",
      priority: safeText(entry.priority, "low") || "low",
      source: safeText(entry.source, "background") || "background",
      category: safeText(entry.category, "program") || "program",
      operation: safeText(entry.operation, "unknown") || "unknown",
      message: safeText(entry.message, "No message.") || "No message.",
      ...(entry.domain ? { domain: safeText(entry.domain) } : {}),
      ...(entry.url ? { url: safeText(entry.url) } : {}),
      ...(entry.model ? { model: safeText(entry.model) } : {}),
      ...(entry.provider ? { provider: safeText(entry.provider) } : {}),
      ...(entry.endpoint ? { endpoint: safeText(entry.endpoint) } : {}),
      ...(entry.status !== undefined && entry.status !== null ? { status: entry.status } : {}),
      ...(entry.summaryId ? { summaryId: safeText(entry.summaryId) } : {}),
      ...(entry.visitId ? { visitId: safeText(entry.visitId) } : {}),
      ...(entry.reportId ? { reportId: safeText(entry.reportId) } : {}),
      ...(entry.details !== undefined ? { details: entry.details } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {})
    };
  }

  async function getDiagnosticLogs() {
    const { diagnosticLogs = [] } = await get({ diagnosticLogs: [] });
    return Array.isArray(diagnosticLogs) ? diagnosticLogs : [];
  }

  async function setDiagnosticLogs(diagnosticLogs) {
    await set({ diagnosticLogs: (Array.isArray(diagnosticLogs) ? diagnosticLogs : []).slice(0, MAX_DIAGNOSTIC_LOGS) });
  }

  async function addDiagnosticLog(entry) {
    const logs = await getDiagnosticLogs();
    const log = normalizeDiagnosticLog(entry);
    await setDiagnosticLogs([log, ...logs].slice(0, MAX_DIAGNOSTIC_LOGS));
    return log;
  }

  async function clearDiagnosticLogs() {
    await set({ diagnosticLogs: [] });
  }

  global.StorageUtils = {
    addDiagnosticLog,
    clearDiagnosticLogs,
    get,
    getArchiveIndex,
    getArchiveLastRun,
    getAnalysisReports,
    getAutoBackupState,
    getDailyStats,
    getDiagnosticLogs,
    getPageSummaries,
    getSettings,
    getState,
    getVisitEvents,
    set,
    setArchiveIndex,
    setArchiveLastRun,
    setAnalysisReports,
    setAutoBackupState,
    setDailyStats,
    setDiagnosticLogs,
    setPageSummaries,
    setSettings,
    setVisitEvents
  };
})(globalThis);
