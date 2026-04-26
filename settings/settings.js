const formEl = document.getElementById("settingsForm");
const statusTextEl = document.getElementById("statusText");
const backupNowEl = document.getElementById("backupNow");
const summarizeNowEl = document.getElementById("summarizeNow");
const exportDataEl = document.getElementById("exportData");
const testSummaryModelEl = document.getElementById("testSummaryModel");
const testAnalysisModelEl = document.getElementById("testAnalysisModel");
const testWebdavEl = document.getElementById("testWebdav");
const summaryTestLightEl = document.getElementById("summaryTestLight");
const analysisTestLightEl = document.getElementById("analysisTestLight");
const webdavTestLightEl = document.getElementById("webdavTestLight");

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
  ignoredDomains: document.getElementById("ignoredDomains"),
  webdavUrl: document.getElementById("webdavUrl"),
  webdavUsername: document.getElementById("webdavUsername"),
  webdavPassword: document.getElementById("webdavPassword"),
  webdavPath: document.getElementById("webdavPath")
};

const PROVIDER_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  siliconflow: "https://api.siliconflow.com/v1",
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

function fillForm(settings) {
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
  fields.ignoredDomains.value = (settings.ignoredDomains || []).join("\n");
  fields.webdavUrl.value = settings.webdav.url;
  fields.webdavUsername.value = settings.webdav.username;
  fields.webdavPassword.value = settings.webdav.password;
  fields.webdavPath.value = settings.webdav.backupPath;
}

function readForm() {
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
      maxContentChars: Number.parseInt(fields.maxContentChars.value, 10) || 12000
    },
    ignoredDomains: fields.ignoredDomains.value
      .split(/\n|,/)
      .map((domain) => domain.trim())
      .filter(Boolean),
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
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Saving settings...");
  fillForm(await sendMessage({ type: "SAVE_SETTINGS", settings: readForm() }));
  setStatus("Settings saved.");
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

backupNowEl.addEventListener("click", async () => {
  setStatus("Backing up to WebDAV...");
  try {
    const result = await sendMessage({ type: "BACKUP_WEBDAV" });
    setStatus(`Backup completed: ${new Date(result.backedUpAt).toLocaleString()}`);
  } catch (error) {
    setStatus(error.message || "Backup failed.");
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
  return sendMessage({ type: "SAVE_SETTINGS", settings: readForm() });
}

testSummaryModelEl.addEventListener("click", async () => {
  setStatus("Testing summary model...");
  setLight(summaryTestLightEl, "");
  await saveBeforeTest();
  try {
    await sendMessage({ type: "TEST_MODEL", target: "summary" });
    setLight(summaryTestLightEl, "ok");
    setStatus("Summary model test passed.");
  } catch (error) {
    setLight(summaryTestLightEl, "fail");
    setStatus(error.message || "Summary model test failed.");
  }
});

testAnalysisModelEl.addEventListener("click", async () => {
  setStatus("Testing analysis model...");
  setLight(analysisTestLightEl, "");
  await saveBeforeTest();
  try {
    await sendMessage({ type: "TEST_MODEL", target: "analysis" });
    setLight(analysisTestLightEl, "ok");
    setStatus("Analysis model test passed.");
  } catch (error) {
    setLight(analysisTestLightEl, "fail");
    setStatus(error.message || "Analysis model test failed.");
  }
});

testWebdavEl.addEventListener("click", async () => {
  setStatus("Testing WebDAV...");
  setLight(webdavTestLightEl, "");
  await saveBeforeTest();
  try {
    await sendMessage({ type: "TEST_WEBDAV" });
    setLight(webdavTestLightEl, "ok");
    setStatus("WebDAV test passed.");
  } catch (error) {
    setLight(webdavTestLightEl, "fail");
    setStatus(error.message || "WebDAV test failed.");
  }
});

loadSettings();
