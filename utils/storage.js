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
      mode: "downloads",
      downloadsFolder: "browser-tracker",
      directoryName: "",
      directoryGrantedAt: 0
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
        ...(settings?.localArchive || {}),
        mode: settings?.localArchive?.mode === "directory" ? "directory" : "downloads",
        downloadsFolder: String(settings?.localArchive?.downloadsFolder || DEFAULT_SETTINGS.localArchive.downloadsFolder)
          .replace(/^\/+|\/+$/g, "")
          .replace(/\.\./g, "")
          .trim() || DEFAULT_SETTINGS.localArchive.downloadsFolder
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
    getAnalysisReports,
    getDailyStats,
    getDiagnosticLogs,
    getPageSummaries,
    getSettings,
    getState,
    getVisitEvents,
    set,
    setAnalysisReports,
    setDailyStats,
    setDiagnosticLogs,
    setPageSummaries,
    setSettings,
    setVisitEvents
  };
})(globalThis);
