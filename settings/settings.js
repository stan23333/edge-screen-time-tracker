const formEl = document.getElementById("settingsForm");
const statusTextEl = document.getElementById("statusText");
const backupNowEl = document.getElementById("backupNow");
const summarizeNowEl = document.getElementById("summarizeNow");
const exportDataEl = document.getElementById("exportData");
const testSummaryModelEl = document.getElementById("testSummaryModel");
const testAnalysisModelEl = document.getElementById("testAnalysisModel");
const testWebdavEl = document.getElementById("testWebdav");
const chooseLocalArchiveFolderEl = document.getElementById("chooseLocalArchiveFolder");
const testLocalArchiveEl = document.getElementById("testLocalArchive");
const summaryTestLightEl = document.getElementById("summaryTestLight");
const analysisTestLightEl = document.getElementById("analysisTestLight");
const webdavTestLightEl = document.getElementById("webdavTestLight");
const localArchiveStatusEl = document.getElementById("localArchiveStatus");
const localArchiveDestinationEl = document.getElementById("localArchiveDestination");
const localArchiveModeNoteEl = document.getElementById("localArchiveModeNote");
const autoBackupStatusEl = document.getElementById("autoBackupStatus");

const fields = {
  summaryProvider: document.getElementById("summaryProvider"),
  summaryBaseUrl: document.getElementById("summaryBaseUrl"),
  summaryApiKey: document.getElementById("summaryApiKey"),
  summaryModel: document.getElementById("summaryModel"),
  summaryPrompt: document.getElementById("summaryPrompt"),
  analysisProvider: document.getElementById("analysisProvider"),
  analysisBaseUrl: document.getElementById("analysisBaseUrl"),
  analysisApiKey: document.getElementById("analysisApiKey"),
  analysisModel: document.getElementById("analysisModel"),
  dailyPrompt: document.getElementById("dailyPrompt"),
  weeklyPrompt: document.getElementById("weeklyPrompt"),
  monthlyPrompt: document.getElementById("monthlyPrompt"),
  autoSummarize: document.getElementById("autoSummarize"),
  maxContentChars: document.getElementById("maxContentChars"),
  screenshotFallbackEnabled: document.getElementById("screenshotFallbackEnabled"),
  screenshotAuthorizedDomains: document.getElementById("screenshotAuthorizedDomains"),
  screenshotPromptedDomains: document.getElementById("screenshotPromptedDomains"),
  ignoredDomains: document.getElementById("ignoredDomains"),
  localArchiveDownloadsFolder: document.getElementById("localArchiveDownloadsFolder"),
  autoBackup: document.getElementById("autoBackup"),
  webdavUrl: document.getElementById("webdavUrl"),
  webdavUsername: document.getElementById("webdavUsername"),
  webdavPassword: document.getElementById("webdavPassword"),
  webdavPath: document.getElementById("webdavPath")
};

let currentSettings = null;

const PROVIDER_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  ollama: "http://localhost:11434/v1"
};

const LOCAL_ARCHIVE_DB = "web-screen-time-tracker-local-archive";
const LOCAL_ARCHIVE_STORE = "handles";
const LOCAL_ARCHIVE_HANDLE_KEY = "directory";

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

async function setDirectoryHandle(handle) {
  const db = await openLocalArchiveDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LOCAL_ARCHIVE_STORE, "readwrite");
    transaction.objectStore(LOCAL_ARCHIVE_STORE).put(handle, LOCAL_ARCHIVE_HANDLE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function endpointFromBaseUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }

  return `${normalized}/chat/completions`;
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (response?.error) {
      throw new Error(response.error);
    }

    return response;
  });
}

function setStatus(message) {
  statusTextEl.textContent = message;
}

function setLight(light, state) {
  light.classList.toggle("ok", state === "ok");
  light.classList.toggle("fail", state === "fail");
}

function formatStatusTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : "";
}

function renderAutoBackupStatus(state = {}) {
  const details = [];
  if (state.enabled === false) {
    details.push("Off");
  }
  if (state.lastSuccessAt) {
    details.push(`Last success: ${formatStatusTime(state.lastSuccessAt)}`);
  }
  if (state.lastCoveredDateKey) {
    details.push(`Covered through: ${state.lastCoveredDateKey}`);
  }
  if (state.pendingRemoteDateKeys?.length) {
    details.push(`WebDAV pending: ${state.pendingRemoteDateKeys.length} date${state.pendingRemoteDateKeys.length === 1 ? "" : "s"}`);
  }
  if (state.lastError) {
    details.push(`Last issue: ${state.lastError}`);
  }
  autoBackupStatusEl.textContent = details.length
    ? details.join(" · ")
    : "No automatic backup has run yet.";
}

function downloadsArchivePath(settings) {
  return `Downloads/${settings?.localArchive?.downloadsFolder || "browser-tracker"}`;
}

function renderLocalArchiveLocation(settings) {
  const downloadsPath = downloadsArchivePath(settings);
  if (settings.localArchive?.mode === "directory") {
    const folderName = settings.localArchive.directoryName || "Selected folder";
    localArchiveStatusEl.textContent = `Selected: ${folderName}`;
    localArchiveDestinationEl.textContent = folderName;
    localArchiveModeNoteEl.textContent = `Primary location is the selected folder. Fallback is ${downloadsPath}.`;
    chooseLocalArchiveFolderEl.textContent = "Change archive folder";
    return;
  }

  localArchiveStatusEl.textContent = `Default: ${downloadsPath}`;
  localArchiveDestinationEl.textContent = downloadsPath;
  localArchiveModeNoteEl.textContent = "Using the default Downloads archive location.";
  chooseLocalArchiveFolderEl.textContent = "Choose local archive folder";
}

async function refreshAutoBackupStatus() {
  try {
    renderAutoBackupStatus(await sendMessage({ type: "GET_AUTO_BACKUP_STATUS" }));
  } catch (error) {
    autoBackupStatusEl.textContent = error.message || "Automatic backup status is unavailable.";
  }
}

function fillForm(settings) {
  currentSettings = settings;
  fields.summaryProvider.value = settings.summaryModel.provider || "openai";
  fields.summaryBaseUrl.value = settings.summaryModel.baseUrl || settings.summaryModel.endpoint?.replace(/\/chat\/completions$/i, "") || "";
  fields.summaryApiKey.value = settings.summaryModel.apiKey;
  fields.summaryModel.value = settings.summaryModel.model;
  fields.summaryPrompt.value = settings.summaryModel.prompt;
  fields.analysisProvider.value = settings.analysisModel.provider || "openai";
  fields.analysisBaseUrl.value = settings.analysisModel.baseUrl || settings.analysisModel.endpoint?.replace(/\/chat\/completions$/i, "") || "";
  fields.analysisApiKey.value = settings.analysisModel.apiKey;
  fields.analysisModel.value = settings.analysisModel.model;
  fields.dailyPrompt.value = settings.analysisModel.dailyPrompt;
  fields.weeklyPrompt.value = settings.analysisModel.weeklyPrompt;
  fields.monthlyPrompt.value = settings.analysisModel.monthlyPrompt;
  fields.autoSummarize.checked = Boolean(settings.capture.autoSummarize);
  fields.maxContentChars.value = String(settings.capture.maxContentChars);
  fields.screenshotFallbackEnabled.checked = settings.capture.screenshotFallbackEnabled !== false;
  fields.screenshotAuthorizedDomains.value = (settings.capture.screenshotAuthorizedDomains || []).join("\n");
  fields.screenshotPromptedDomains.value = Object.keys(settings.capture.screenshotPromptedDomains || {}).sort().join("\n");
  fields.ignoredDomains.value = (settings.ignoredDomains || []).join("\n");
  fields.localArchiveDownloadsFolder.value = settings.localArchive?.downloadsFolder || "browser-tracker";
  fields.autoBackup.checked = settings.autoBackup?.enabled !== false;
  renderLocalArchiveLocation(settings);
  fields.webdavUrl.value = settings.webdav.url;
  fields.webdavUsername.value = settings.webdav.username;
  fields.webdavPassword.value = settings.webdav.password;
  fields.webdavPath.value = settings.webdav.backupPath;
}

function readForm() {
  const previousCapture = currentSettings?.capture || {};
  return {
    summaryModel: {
      provider: fields.summaryProvider.value,
      baseUrl: fields.summaryBaseUrl.value.trim(),
      endpoint: endpointFromBaseUrl(fields.summaryBaseUrl.value),
      apiKey: fields.summaryApiKey.value.trim(),
      model: fields.summaryModel.value.trim(),
      prompt: fields.summaryPrompt.value.trim()
    },
    analysisModel: {
      provider: fields.analysisProvider.value,
      baseUrl: fields.analysisBaseUrl.value.trim(),
      endpoint: endpointFromBaseUrl(fields.analysisBaseUrl.value),
      apiKey: fields.analysisApiKey.value.trim(),
      model: fields.analysisModel.value.trim(),
      dailyPrompt: fields.dailyPrompt.value.trim(),
      weeklyPrompt: fields.weeklyPrompt.value.trim(),
      monthlyPrompt: fields.monthlyPrompt.value.trim()
    },
    capture: {
      autoSummarize: fields.autoSummarize.checked,
      autoSummarizeTouched: true,
      maxContentChars: Number.parseInt(fields.maxContentChars.value, 10) || 12000,
      screenshotFallbackEnabled: fields.screenshotFallbackEnabled.checked,
      screenshotAuthorizedDomains: fields.screenshotAuthorizedDomains.value
        .split(/\n|,/)
        .map((domain) => domain.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase())
        .filter(Boolean),
      screenshotPromptedDomains: previousCapture.screenshotPromptedDomains || {},
      screenshotLastCaptureByDomain: previousCapture.screenshotLastCaptureByDomain || {}
    },
    ignoredDomains: fields.ignoredDomains.value
      .split(/\n|,/)
      .map((domain) => domain.trim())
      .filter(Boolean),
    localArchive: {
      ...(currentSettings?.localArchive || {}),
      downloadsFolder: fields.localArchiveDownloadsFolder.value.trim() || "browser-tracker"
    },
    autoBackup: {
      enabled: fields.autoBackup.checked
    },
    webdav: {
      url: fields.webdavUrl.value.trim(),
      username: fields.webdavUsername.value.trim(),
      password: fields.webdavPassword.value,
      backupPath: fields.webdavPath.value.trim() || "browser-tracker"
    }
  };
}

function bindProviderSelect(selectEl, baseUrlEl) {
  selectEl.addEventListener("change", () => {
    const preset = PROVIDER_BASE_URLS[selectEl.value];
    if (preset) {
      baseUrlEl.value = preset;
    }
  });

  baseUrlEl.addEventListener("input", () => {
    const matched = Object.entries(PROVIDER_BASE_URLS)
      .find(([, value]) => value === baseUrlEl.value.trim());
    selectEl.value = matched?.[0] || "custom";
  });
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function loadSettings() {
  fillForm(await sendMessage({ type: "GET_SETTINGS" }));
  await refreshAutoBackupStatus();
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Saving settings...");
  try {
    fillForm(await sendMessage({ type: "SAVE_SETTINGS", settings: readForm() }));
    await refreshAutoBackupStatus();
    setStatus("Settings saved.");
  } catch (error) {
    setStatus(error.message || "Failed to save settings.");
  }
});

fields.autoSummarize.addEventListener("change", async () => {
  setStatus("Saving auto summarize setting...");
  try {
    fillForm(await sendMessage({ type: "SAVE_SETTINGS", settings: readForm() }));
    setStatus(fields.autoSummarize.checked ? "Auto summarize is on." : "Auto summarize is off.");
  } catch (error) {
    setStatus(error.message || "Failed to save auto summarize setting.");
  }
});

fields.autoBackup.addEventListener("change", async () => {
  setStatus("Saving auto backup setting...");
  try {
    fillForm(await sendMessage({ type: "SAVE_SETTINGS", settings: readForm() }));
    await refreshAutoBackupStatus();
    setStatus(fields.autoBackup.checked ? "Auto backup is on." : "Auto backup is off.");
  } catch (error) {
    setStatus(error.message || "Failed to save auto backup setting.");
  }
});

backupNowEl.addEventListener("click", async () => {
  setStatus("Running manual archive and WebDAV backup...");
  try {
    const result = await sendMessage({ type: "BACKUP_WEBDAV" });
    const localRecordCount = result.local?.records?.results?.length || 0;
    const localAnalysisCount = result.local?.analysis?.length || 0;
    const remoteRecordCount = result.remote?.records?.results?.length || 0;
    const remoteAnalysisCount = result.remote?.analysis?.length || 0;
    const remoteNote = result.remote?.records?.skipped ? " WebDAV is not configured." : "";
    setStatus(`Archive completed: ${localRecordCount} local record files, ${localAnalysisCount} local analysis files; ${remoteRecordCount} remote record files, ${remoteAnalysisCount} remote analysis files.${remoteNote}`);
  } catch (error) {
    setStatus(error.message || "Archive failed.");
  }
});

summarizeNowEl.addEventListener("click", async () => {
  setStatus("Summarizing current page...");
  try {
    const result = await sendMessage({ type: "SUMMARIZE_ACTIVE_TAB" });
    setStatus(result.status === "done" ? "Current page summarized." : result.error || "Summary failed.");
  } catch (error) {
    setStatus(error.message || "Summary failed.");
  }
});

exportDataEl.addEventListener("click", async () => {
  const data = await sendMessage({ type: "EXPORT_FULL_DATA" });
  downloadJson(`browser-tracker-${new Date().toISOString().slice(0, 10)}.json`, data);
});

bindProviderSelect(fields.summaryProvider, fields.summaryBaseUrl);
bindProviderSelect(fields.analysisProvider, fields.analysisBaseUrl);

async function saveBeforeTest() {
  const settings = await sendMessage({ type: "SAVE_SETTINGS", settings: readForm() });
  fillForm(settings);
  return settings;
}

async function runButtonTask(button, pendingMessage, task) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Testing...";
  setStatus(pendingMessage);
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

testSummaryModelEl.addEventListener("click", async () => {
  await runButtonTask(testSummaryModelEl, "Testing summary model...", async () => {
    setLight(summaryTestLightEl, "");
    await saveBeforeTest();
    await sendMessage({ type: "TEST_MODEL", target: "summary" });
    setLight(summaryTestLightEl, "ok");
    setStatus("Summary model test passed.");
  }).catch((error) => {
    setLight(summaryTestLightEl, "fail");
    setStatus(error.message || "Summary model test failed.");
  });
});

testAnalysisModelEl.addEventListener("click", async () => {
  await runButtonTask(testAnalysisModelEl, "Testing analysis model...", async () => {
    setLight(analysisTestLightEl, "");
    await saveBeforeTest();
    await sendMessage({ type: "TEST_MODEL", target: "analysis" });
    setLight(analysisTestLightEl, "ok");
    setStatus("Analysis model test passed.");
  }).catch((error) => {
    setLight(analysisTestLightEl, "fail");
    setStatus(error.message || "Analysis model test failed.");
  });
});

chooseLocalArchiveFolderEl.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    setStatus("Folder selection is not supported here. The extension will use the Downloads fallback.");
    localArchiveStatusEl.textContent = "Downloads fallback";
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const permission = await handle.requestPermission?.({ mode: "readwrite" });
    if (permission && permission !== "granted") {
      throw new Error("Folder permission was not granted.");
    }
    await setDirectoryHandle(handle);
    const settings = readForm();
    settings.localArchive = {
      ...settings.localArchive,
      mode: "directory",
      directoryName: handle.name || "Selected folder",
      directoryGrantedAt: Date.now()
    };
    fillForm(await sendMessage({ type: "SAVE_SETTINGS", settings }));
    setStatus(`Local archive folder selected: ${handle.name || "Selected folder"}.`);
  } catch (error) {
    setStatus(error.message || "Failed to select local archive folder.");
  }
});

testLocalArchiveEl.addEventListener("click", async () => {
  await runButtonTask(testLocalArchiveEl, "Testing local archive...", async () => {
    await saveBeforeTest();
    const result = await sendMessage({ type: "TEST_LOCAL_ARCHIVE" });
    renderLocalArchiveLocation(currentSettings);
    const fallbackNote = result.status === "fallback" ? ` Fallback reason: ${result.fallbackReason}` : "";
    setStatus(`Local archive test passed: ${result.displayPath || result.relativePath}.${fallbackNote}`);
  }).catch((error) => {
    setStatus(error.message || "Local archive test failed.");
  });
});

testWebdavEl.addEventListener("click", async () => {
  await runButtonTask(testWebdavEl, "Testing WebDAV...", async () => {
    setLight(webdavTestLightEl, "");
    await saveBeforeTest();
    await sendMessage({ type: "TEST_WEBDAV" });
    setLight(webdavTestLightEl, "ok");
    setStatus("WebDAV test passed.");
  }).catch((error) => {
    setLight(webdavTestLightEl, "fail");
    setStatus(error.message || "WebDAV test failed.");
  });
});

loadSettings();
