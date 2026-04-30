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
const localArchivePermissionCardEl = document.getElementById("localArchivePermissionCard");
const localArchivePermissionStatusEl = document.getElementById("localArchivePermissionStatus");
const localArchivePermissionDetailEl = document.getElementById("localArchivePermissionDetail");
const reauthorizeLocalArchiveEl = document.getElementById("reauthorizeLocalArchive");
const flushLocalArchivePendingEl = document.getElementById("flushLocalArchivePending");
const archiveRunDetailsEl = document.getElementById("archiveRunDetails");
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

function renderLocalArchiveLocation(settings) {
  if (settings.localArchive?.mode === "directory") {
    const folderName = settings.localArchive.directoryName || "Selected folder";
    localArchiveStatusEl.textContent = `Selected: ${folderName}`;
    localArchiveDestinationEl.textContent = folderName;
    localArchiveModeNoteEl.textContent = "Automatic archives write directly to the selected folder without browser downloads.";
    chooseLocalArchiveFolderEl.textContent = "Change archive folder";
    return;
  }

  localArchiveStatusEl.textContent = "Folder required";
  localArchiveDestinationEl.textContent = "No folder selected";
  localArchiveModeNoteEl.textContent = "Choose a local archive folder to enable silent automatic archives. Until then, local archive writes are skipped.";
  chooseLocalArchiveFolderEl.textContent = "Choose local archive folder";
}

function renderLocalArchivePermission(status = {}) {
  localArchivePermissionCardEl.classList.remove("granted", "needs", "failed");
  if (status.status === "granted") {
    localArchivePermissionCardEl.classList.add("granted");
    localArchivePermissionStatusEl.textContent = "Granted";
    localArchivePermissionDetailEl.textContent = `${status.name || "Selected folder"} is available for silent archive writes.`;
    reauthorizeLocalArchiveEl.disabled = false;
    flushLocalArchivePendingEl.disabled = false;
    return;
  }

  if (status.status === "needs_reauthorize") {
    localArchivePermissionCardEl.classList.add("needs");
    localArchivePermissionStatusEl.textContent = "Needs reauthorize";
    localArchivePermissionDetailEl.textContent = status.reason || "Click Reauthorize to restore local archive writes.";
    reauthorizeLocalArchiveEl.disabled = false;
    flushLocalArchivePendingEl.disabled = false;
    return;
  }

  if (status.status === "write_failed") {
    localArchivePermissionCardEl.classList.add("failed");
    localArchivePermissionStatusEl.textContent = "Write failed";
    localArchivePermissionDetailEl.textContent = status.reason || "The selected folder could not be used.";
    reauthorizeLocalArchiveEl.disabled = false;
    flushLocalArchivePendingEl.disabled = false;
    return;
  }

  localArchivePermissionStatusEl.textContent = "Not selected";
  localArchivePermissionDetailEl.textContent = "Choose a local archive folder once to enable silent local archives.";
  reauthorizeLocalArchiveEl.disabled = true;
  flushLocalArchivePendingEl.disabled = true;
}

function renderArchiveRunDetails(run = {}) {
  archiveRunDetailsEl.textContent = "";
  const results = Array.isArray(run.results) ? run.results : [];
  if (!run.at && !results.length) {
    return;
  }

  const label = document.createElement("span");
  label.textContent = run.at
    ? `Last archive run: ${new Date(run.at).toLocaleString()}`
    : "Archive results";
  const summary = document.createElement("strong");
  const counts = run.summary || {};
  summary.textContent = `done ${counts.done || 0} · pending ${counts.pending || 0} · skipped ${counts.skipped || 0} · error ${counts.error || 0}`;
  archiveRunDetailsEl.append(label, summary);

  if (results.length) {
    const list = document.createElement("ul");
    for (const item of results.slice(0, 8)) {
      const row = document.createElement("li");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      title.textContent = `${item.kind || "archive"} / ${item.target || "target"}: ${item.status || "unknown"}`;
      detail.textContent = item.message || item.path || item.entryId || "";
      row.append(title, detail);
      list.append(row);
    }
    archiveRunDetailsEl.append(list);
  }
}

async function refreshArchiveStatus() {
  try {
    const browserStatus = await LocalArchivePermission.permissionStatus();
    const archiveStatus = await sendMessage({ type: "GET_ARCHIVE_STATUS" });
    renderLocalArchivePermission(browserStatus.status === "not_selected" ? archiveStatus.localArchive : browserStatus);
    renderArchiveRunDetails(archiveStatus.archiveLastRun);
  } catch (error) {
    renderLocalArchivePermission({
      status: "write_failed",
      reason: error.message || "Local archive status is unavailable."
    });
  }
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
      ...(currentSettings?.localArchive || {})
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
  await refreshArchiveStatus();
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Saving settings...");
  try {
    fillForm(await sendMessage({ type: "SAVE_SETTINGS", settings: readForm() }));
    await refreshAutoBackupStatus();
    await refreshArchiveStatus();
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
    await sendMessage({ type: "BACKUP_WEBDAV" });
    const status = await sendMessage({ type: "GET_ARCHIVE_STATUS" });
    renderArchiveRunDetails(status.archiveLastRun);
    await refreshAutoBackupStatus();
    await refreshArchiveStatus();
    const pending = status.archiveLastRun?.summary?.pending || 0;
    const errors = status.archiveLastRun?.summary?.error || 0;
    const skipped = status.archiveLastRun?.summary?.skipped || 0;
    setStatus(`Manual archive finished. Done ${status.archiveLastRun?.summary?.done || 0}, pending ${pending}, skipped ${skipped}, errors ${errors}.`);
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
    setStatus("Folder selection is not supported here, so silent local archives are unavailable.");
    localArchiveStatusEl.textContent = "Folder unavailable";
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await LocalArchivePermission.grantDirectoryHandle(handle);
    const settings = readForm();
    settings.localArchive = {
      ...settings.localArchive,
      mode: "directory",
      directoryName: handle.name || "Selected folder",
      directoryGrantedAt: Date.now()
    };
    fillForm(await sendMessage({ type: "SAVE_SETTINGS", settings }));
    const flush = await sendMessage({ type: "FLUSH_LOCAL_ARCHIVE_PENDING" });
    renderArchiveRunDetails(flush.archiveLastRun);
    await refreshArchiveStatus();
    setStatus(`Local archive folder selected: ${handle.name || "Selected folder"}. Pending local files were checked.`);
  } catch (error) {
    setStatus(error.message || "Failed to select local archive folder.");
  }
});

reauthorizeLocalArchiveEl.addEventListener("click", async () => {
  setStatus("Reauthorizing local archive folder...");
  try {
    const permission = await LocalArchivePermission.reauthorize();
    if (!permission.ok) {
      setStatus(permission.reason || "Local archive folder permission is not granted.");
      await refreshArchiveStatus();
      return;
    }
    const flush = await sendMessage({ type: "FLUSH_LOCAL_ARCHIVE_PENDING" });
    renderArchiveRunDetails(flush.archiveLastRun);
    await refreshArchiveStatus();
    setStatus("Local archive permission restored. Pending local files were checked.");
  } catch (error) {
    setStatus(error.message || "Failed to reauthorize local archive folder.");
    await refreshArchiveStatus();
  }
});

flushLocalArchivePendingEl.addEventListener("click", async () => {
  setStatus("Checking pending local archive files...");
  try {
    const flush = await sendMessage({ type: "FLUSH_LOCAL_ARCHIVE_PENDING" });
    renderArchiveRunDetails(flush.archiveLastRun);
    await refreshArchiveStatus();
    setStatus(`Pending local archive check finished. Done ${flush.archiveLastRun?.summary?.done || 0}, pending ${flush.archiveLastRun?.summary?.pending || 0}, errors ${flush.archiveLastRun?.summary?.error || 0}.`);
  } catch (error) {
    setStatus(error.message || "Pending local archive check failed.");
  }
});

testLocalArchiveEl.addEventListener("click", async () => {
  await runButtonTask(testLocalArchiveEl, "Testing local archive...", async () => {
    await saveBeforeTest();
    const result = await sendMessage({ type: "TEST_LOCAL_ARCHIVE" });
    renderLocalArchiveLocation(currentSettings);
    await refreshArchiveStatus();
    if (result.status === "skipped") {
      setStatus(result.reason || "Choose a local archive folder before testing local archives.");
      return;
    }
    setStatus(`Local archive test passed: ${result.displayPath || result.relativePath}.`);
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
