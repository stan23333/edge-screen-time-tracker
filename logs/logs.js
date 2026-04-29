const logCountEl = document.getElementById("logCount");
const levelFilterEl = document.getElementById("levelFilter");
const priorityFilterEl = document.getElementById("priorityFilter");
const sourceFilterEl = document.getElementById("sourceFilter");
const categoryFilterEl = document.getElementById("categoryFilter");
const searchInputEl = document.getElementById("searchInput");
const refreshLogsEl = document.getElementById("refreshLogs");
const exportLogsEl = document.getElementById("exportLogs");
const clearLogsEl = document.getElementById("clearLogs");
const confirmClearEl = document.getElementById("confirmClear");
const confirmClearLogsEl = document.getElementById("confirmClearLogs");
const cancelClearLogsEl = document.getElementById("cancelClearLogs");
const highCountEl = document.getElementById("highCount");
const mediumCountEl = document.getElementById("mediumCount");
const lowCountEl = document.getElementById("lowCount");
const visibleCountEl = document.getElementById("visibleCount");
const filterSummaryEl = document.getElementById("filterSummary");
const logListEl = document.getElementById("logList");
const emptyStateEl = document.getElementById("emptyState");
const detailTitleEl = document.getElementById("detailTitle");
const detailJsonEl = document.getElementById("detailJson");

let logs = [];
let selectedLogId = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (response?.error) {
      throw new Error(response.error);
    }
    return response;
  });
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "Unknown time";
  }
  return new Date(timestamp).toLocaleString();
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

function textForSearch(log) {
  return [
    log.level,
    log.priority,
    log.source,
    log.category,
    log.operation,
    log.message,
    log.domain,
    log.url,
    log.model,
    log.provider,
    log.endpoint,
    log.status,
    log.summaryId,
    log.visitId,
    log.reportId,
    JSON.stringify(log.details || {}),
    JSON.stringify(log.error || {})
  ].filter(Boolean).join(" ").toLowerCase();
}

function matchesFilters(log) {
  const level = levelFilterEl.value;
  const priority = priorityFilterEl.value;
  const source = sourceFilterEl.value;
  const category = categoryFilterEl.value;
  const search = searchInputEl.value.trim().toLowerCase();

  if (level !== "all" && log.level !== level) {
    return false;
  }

  if (priority === "important" && !["high", "medium"].includes(log.priority)) {
    return false;
  }
  if (!["all", "important"].includes(priority) && log.priority !== priority) {
    return false;
  }

  if (source !== "all" && log.source !== source) {
    return false;
  }

  if (category !== "all" && log.category !== category) {
    return false;
  }

  return !search || textForSearch(log).includes(search);
}

function countsByPriority(items) {
  return items.reduce((counts, log) => {
    counts[log.priority] = (counts[log.priority] || 0) + 1;
    return counts;
  }, {});
}

function setSelectOptions(select, values) {
  const currentValue = select.value;
  const base = document.createElement("option");
  base.value = "all";
  base.textContent = "All";
  select.textContent = "";
  select.append(base);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  select.value = [...select.options].some((option) => option.value === currentValue) ? currentValue : "all";
}

function renderFilters() {
  const sources = [...new Set(logs.map((log) => log.source).filter(Boolean))].sort();
  const categories = [...new Set(logs.map((log) => log.category).filter(Boolean))].sort();
  setSelectOptions(sourceFilterEl, sources);
  setSelectOptions(categoryFilterEl, categories);
}

function chip(text) {
  const node = document.createElement("span");
  node.className = "chip";
  node.textContent = text;
  node.title = text;
  return node;
}

function renderDetail(log) {
  if (!log) {
    detailTitleEl.textContent = "Details";
    detailJsonEl.textContent = "Select a log entry.";
    selectedLogId = null;
    return;
  }

  selectedLogId = log.id;
  detailTitleEl.textContent = log.operation || "Log entry";
  detailJsonEl.textContent = JSON.stringify(log, null, 2);
  document.querySelectorAll(".logRow").forEach((row) => {
    row.classList.toggle("active", row.dataset.logId === selectedLogId);
  });
}

function renderLogRow(log) {
  const button = document.createElement("button");
  const time = document.createElement("span");
  const level = document.createElement("span");
  const priority = document.createElement("span");
  const source = document.createElement("span");
  const main = document.createElement("span");
  const title = document.createElement("strong");
  const meta = document.createElement("span");
  const chips = document.createElement("span");

  button.type = "button";
  button.className = `logRow ${log.level || "info"} ${log.priority || "low"}`;
  button.dataset.logId = log.id;

  time.className = "logTime";
  level.className = `logLevel ${log.level || "info"}`;
  priority.className = `logPriority ${log.priority || "low"}`;
  source.className = "logSource";
  main.className = "logMain";
  chips.className = "chips";

  time.textContent = formatTime(log.createdAt);
  level.textContent = log.level || "info";
  priority.textContent = log.priority || "low";
  source.textContent = log.source || "unknown";
  title.textContent = log.message || "No message.";
  meta.textContent = [log.category, log.operation].filter(Boolean).join(" | ");

  [
    log.domain && `domain: ${log.domain}`,
    log.model && `model: ${log.model}`,
    log.status !== undefined && log.status !== null && `status: ${log.status}`,
    log.summaryId && `summary: ${log.summaryId}`,
    log.reportId && `report: ${log.reportId}`
  ].filter(Boolean).forEach((value) => chips.append(chip(value)));

  main.append(title, meta, chips);
  button.append(time, level, priority, source, main);
  button.addEventListener("click", () => renderDetail(log));
  return button;
}

function renderSummary(filtered) {
  const counts = countsByPriority(logs);
  highCountEl.textContent = String(counts.high || 0);
  mediumCountEl.textContent = String(counts.medium || 0);
  lowCountEl.textContent = String(counts.low || 0);
  visibleCountEl.textContent = String(filtered.length);
  logCountEl.textContent = `${logs.length} logs`;

  const pieces = [];
  if (priorityFilterEl.value === "important") {
    pieces.push("High + medium");
  } else if (priorityFilterEl.value !== "all") {
    pieces.push(priorityFilterEl.value);
  }
  if (levelFilterEl.value !== "all") {
    pieces.push(levelFilterEl.value);
  }
  if (sourceFilterEl.value !== "all") {
    pieces.push(sourceFilterEl.value);
  }
  if (categoryFilterEl.value !== "all") {
    pieces.push(categoryFilterEl.value);
  }
  filterSummaryEl.textContent = pieces.length ? pieces.join(" / ") : "All logs";
}

function render() {
  const filtered = logs.filter(matchesFilters);
  logListEl.textContent = "";
  emptyStateEl.style.display = filtered.length ? "none" : "block";
  renderSummary(filtered);

  for (const log of filtered) {
    logListEl.append(renderLogRow(log));
  }

  const selected = filtered.find((log) => log.id === selectedLogId) || filtered[0] || null;
  renderDetail(selected);
}

async function loadLogs() {
  refreshLogsEl.disabled = true;
  try {
    const data = await sendMessage({ type: "GET_LOGS" });
    logs = Array.isArray(data.logs) ? data.logs : [];
    renderFilters();
    render();
  } catch (error) {
    detailTitleEl.textContent = "Load failed";
    detailJsonEl.textContent = error.message || "Failed to load logs.";
  } finally {
    refreshLogsEl.disabled = false;
  }
}

[levelFilterEl, priorityFilterEl, sourceFilterEl, categoryFilterEl].forEach((select) => {
  select.addEventListener("change", render);
});

searchInputEl.addEventListener("input", render);

refreshLogsEl.addEventListener("click", loadLogs);

exportLogsEl.addEventListener("click", async () => {
  const data = await sendMessage({ type: "EXPORT_LOGS" });
  downloadJson(`browser-tracker-logs-${new Date().toISOString().slice(0, 10)}.json`, data);
});

clearLogsEl.addEventListener("click", () => {
  confirmClearEl.hidden = false;
});

cancelClearLogsEl.addEventListener("click", () => {
  confirmClearEl.hidden = true;
});

confirmClearLogsEl.addEventListener("click", async () => {
  confirmClearLogsEl.disabled = true;
  try {
    await sendMessage({ type: "CLEAR_LOGS" });
    logs = [];
    selectedLogId = null;
    confirmClearEl.hidden = true;
    renderFilters();
    render();
  } finally {
    confirmClearLogsEl.disabled = false;
  }
});

loadLogs();
