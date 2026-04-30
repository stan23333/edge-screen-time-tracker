const endDateEl = document.getElementById("endDate");
const reportListEl = document.getElementById("reportList");
const reportMetaEl = document.getElementById("reportMeta");
const reportTitleEl = document.getElementById("reportTitle");
const reportBodyEl = document.getElementById("reportBody");
const reportUsageEl = document.getElementById("reportUsage");
const reportBackupEl = document.getElementById("reportBackup");
const reportCountEl = document.getElementById("reportCount");
const summaryCountEl = document.getElementById("summaryCount");
const tokenCountEl = document.getElementById("tokenCount");
const errorCountEl = document.getElementById("errorCount");
const lowEvidenceCountEl = document.getElementById("lowEvidenceCount");
const topicListEl = document.getElementById("topicList");
const evidenceBarsEl = document.getElementById("evidenceBars");
const summaryTrendEl = document.getElementById("summaryTrend");
const analysisStatusEl = document.getElementById("analysisStatus");

let reports = {};
let pageSummaries = {};
let analysisStatus = null;
let selectedReportId = null;
let activeRun = null;
let statusTimer = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (response?.error) {
      throw new Error(response.error);
    }
    return response;
  });
}

function allReports() {
  return Object.values(reports)
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt);
}

function upsertReport(report) {
  reports[report.period] = reports[report.period] || [];
  const index = reports[report.period].findIndex((item) => item.id === report.id);
  if (index >= 0) {
    reports[report.period][index] = report;
  } else {
    reports[report.period].unshift(report);
  }
}

function renderReport(report) {
  selectedReportId = report.id;
  reportMetaEl.textContent = `${report.period} | ${report.startDate} to ${report.endDate} | ${new Date(report.createdAt).toLocaleString()}`;
  reportTitleEl.textContent = `${report.period[0].toUpperCase()}${report.period.slice(1)} Analysis`;
  renderMarkdown(reportBodyEl, report.report);
  renderBackupInfo(report);
  reportUsageEl.textContent = report.usage?.total_tokens
    ? `${report.usage.total_tokens.toLocaleString()} tokens`
    : "Tokens not reported";
  document.querySelectorAll(".reportItem").forEach((item) => {
    item.classList.toggle("active", item.dataset.reportId === report.id);
  });
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

async function openLocalArchiveWithRepair(relativePath, entryId, button) {
  const previewWindow = window.open("about:blank", "_blank");
  if (previewWindow) {
    previewWindow.opener = null;
  }
  try {
    await LocalArchivePermission.openFile(relativePath, previewWindow);
    return;
  } catch (error) {
    if (!LocalArchivePermission.isMissingFileError?.(error) || !entryId) {
      if (previewWindow && !previewWindow.closed) {
        previewWindow.close();
      }
      throw error;
    }
  }

  const originalText = button.textContent;
  button.textContent = "Re-archiving...";
  const retry = await sendMessage({
    type: "RETRY_ARCHIVE_ENTRIES",
    entryIds: [entryId],
    targets: "local",
    trigger: "open_missing_local"
  });
  const failed = (retry.results || []).find((item) => item.target === "local" && !["done"].includes(item.status));
  if (failed) {
    if (previewWindow && !previewWindow.closed) {
      previewWindow.close();
    }
    throw new Error(failed.message || "Local archive file is missing and could not be rebuilt.");
  }
  button.textContent = "Opening...";
  try {
    await LocalArchivePermission.openFile(relativePath, previewWindow);
  } catch (error) {
    if (previewWindow && !previewWindow.closed) {
      previewWindow.close();
    }
    throw error;
  }
  button.textContent = originalText;
}

function backupStatusText(backup) {
  if (!backup) {
    return "Archive path appears after a report is generated.";
  }
  const local = backup.local || backup;
  if (local.status === "error" || local.error) {
    return `Local archive failed: ${local.error || "Unknown error"}`;
  }
  return "";
}

function renderBackupInfo(report) {
  const backup = report.backup || null;
  reportBackupEl.textContent = "";
  const status = backupStatusText(backup);
  if (status) {
    reportBackupEl.textContent = status;
    return;
  }

  const localInfo = backup?.local || backup || {};
  const remoteInfo = backup?.remote || {};
  const remote = document.createElement("p");
  const local = document.createElement("p");
  const actions = document.createElement("div");
  const openLocal = document.createElement("button");
  const openRemote = document.createElement("button");
  const copyLocal = document.createElement("button");
  const copyFolder = document.createElement("button");
  const deleteArchive = document.createElement("button");

  if (localInfo.status === "deleted") {
    local.textContent = `Local: Deleted${localInfo.relativePath ? ` (${localInfo.relativePath})` : ""}`;
  } else if (localInfo.displayPath) {
    local.textContent = `Local: ${localInfo.displayPath}`;
  } else if (localInfo.status === "pending") {
    local.textContent = `Local: Pending${localInfo.reason ? ` - ${localInfo.reason}` : ""}`;
  } else if (localInfo.skipped || localInfo.status === "skipped") {
    local.textContent = `Local: ${localInfo.reason || "Choose a local archive folder in Settings."}`;
  } else {
    local.textContent = "Local: Not archived yet.";
  }
  if (remoteInfo.status === "deleted") {
    remote.textContent = `Remote: Deleted${remoteInfo.remotePath ? ` (${remoteInfo.remotePath})` : ""}`;
  } else if (remoteInfo.remotePath) {
    remote.textContent = `Remote: ${remoteInfo.remotePath}`;
  } else if (remoteInfo.status === "error" || remoteInfo.error) {
    remote.textContent = `Remote: ${remoteInfo.error || "WebDAV backup failed."}`;
  } else if (remoteInfo.status === "pending") {
    remote.textContent = `Remote: Pending${remoteInfo.reason ? ` - ${remoteInfo.reason}` : ""}`;
  } else if (remoteInfo.skipped || remoteInfo.status === "skipped") {
    remote.textContent = `Remote: ${remoteInfo.reason || "WebDAV is not configured."}`;
  } else {
    remote.textContent = "Remote: Not backed up yet.";
  }
  actions.className = "backupActions";

  openLocal.type = "button";
  openLocal.className = "archiveAction openLocal";
  openLocal.textContent = "Open Local Folder";
  openLocal.disabled = !localInfo.relativePath || localInfo.status === "deleted";
  openLocal.addEventListener("click", async () => {
    await copyText(localInfo.folderPath);
    const originalText = openLocal.textContent;
    openLocal.textContent = "Copied";
    setTimeout(() => {
      openLocal.textContent = originalText;
    }, 1200);
  });

  openRemote.type = "button";
  openRemote.className = "archiveAction remote";
  openRemote.textContent = "Open Remote";
  openRemote.disabled = !remoteInfo.remoteUrl || remoteInfo.status === "deleted";
  openRemote.addEventListener("click", () => {
    if (remoteInfo.remoteUrl) {
      window.open(remoteInfo.remoteUrl, "_blank", "noopener");
    }
  });

  copyLocal.type = "button";
  copyLocal.className = "archiveAction copyFile";
  copyLocal.textContent = "Copy File Path";
  copyLocal.disabled = !localInfo.displayPath;
  copyLocal.addEventListener("click", async () => {
    await copyText(localInfo.displayPath);
    copyLocal.textContent = "Copied";
    setTimeout(() => {
      copyLocal.textContent = "Copy File Path";
    }, 1200);
  });

  copyFolder.type = "button";
  copyFolder.className = "archiveAction copyFolder";
  copyFolder.textContent = "Copy Folder Path";
  copyFolder.disabled = !localInfo.folderPath;
  copyFolder.addEventListener("click", async () => {
    await copyText(localInfo.folderPath);
    copyFolder.textContent = "Copied";
    setTimeout(() => {
      copyFolder.textContent = "Copy Folder Path";
    }, 1200);
  });

  deleteArchive.type = "button";
  deleteArchive.className = "archiveAction deleteArchive";
  deleteArchive.textContent = "Delete Archive";
  deleteArchive.disabled = (!localInfo.relativePath && !remoteInfo.remotePath)
    || (localInfo.status === "deleted" && remoteInfo.status === "deleted");
  deleteArchive.addEventListener("click", async () => {
    if (!window.confirm("Delete this report archive from the local archive and WebDAV? The in-app report remains.")) {
      return;
    }

    const originalText = deleteArchive.textContent;
    deleteArchive.disabled = true;
    deleteArchive.textContent = "Deleting...";
    reportBackupEl.textContent = "Deleting local and WebDAV archive files...";
    try {
      const updated = await sendMessage({
        type: "DELETE_ANALYSIS_ARCHIVE",
        reportId: report.id
      });
      upsertReport(updated);
      renderList();
      renderReport(updated);
    } catch (error) {
      reportBackupEl.textContent = error.message || "Delete failed.";
      deleteArchive.disabled = false;
      deleteArchive.textContent = originalText;
    }
  });

  actions.append(openLocal, copyLocal, copyFolder, openRemote, deleteArchive);
  reportBackupEl.append(remote, local, actions);
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) {
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
    }
    const raw = match[0];
    const node = raw.startsWith("`") ? document.createElement("code") : document.createElement("strong");
    node.textContent = raw.startsWith("`") ? raw.slice(1, -1) : raw.slice(2, -2);
    parent.append(node);
    cursor = match.index + raw.length;
  }
  if (cursor < text.length) {
    parent.append(document.createTextNode(text.slice(cursor)));
  }
}

function isTableSeparator(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return false;
  }
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdown(container, markdown) {
  container.textContent = "";
  const lines = String(markdown || "").split(/\r?\n/);
  let list = null;
  let codeBlock = null;

  const closeList = () => {
    list = null;
  };
  const closeCode = () => {
    codeBlock = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line.trim())) {
      closeList();
      if (codeBlock) {
        closeCode();
      } else {
        codeBlock = document.createElement("pre");
        codeBlock.className = "mdCodeBlock";
        container.append(codeBlock);
      }
      continue;
    }

    if (codeBlock) {
      codeBlock.textContent += `${line}\n`;
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      closeList();
      container.append(document.createElement("hr"));
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] || "")) {
      closeList();
      const headers = parseTableRow(line);
      const tableWrap = document.createElement("div");
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      const tbody = document.createElement("tbody");
      tableWrap.className = "mdTableWrap";
      table.className = "mdTable";

      for (const header of headers) {
        const cell = document.createElement("th");
        appendInlineMarkdown(cell, header);
        headRow.append(cell);
      }
      thead.append(headRow);
      table.append(thead, tbody);

      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|") && !/^```/.test(lines[index].trim())) {
        const row = document.createElement("tr");
        const cells = parseTableRow(lines[index]);
        for (let cellIndex = 0; cellIndex < headers.length; cellIndex += 1) {
          const cell = document.createElement("td");
          appendInlineMarkdown(cell, cells[cellIndex] || "");
          row.append(cell);
        }
        tbody.append(row);
        index += 1;
      }
      index -= 1;
      tableWrap.append(table);
      container.append(tableWrap);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length + 1);
      const node = document.createElement(`h${level}`);
      appendInlineMarkdown(node, heading[2].trim());
      container.append(node);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!list) {
        list = document.createElement("ul");
        container.append(list);
      }
      const item = document.createElement("li");
      appendInlineMarkdown(item, bullet[1].trim());
      list.append(item);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      if (!list || list.tagName !== "OL") {
        list = document.createElement("ol");
        container.append(list);
      }
      const item = document.createElement("li");
      appendInlineMarkdown(item, ordered[1].trim());
      list.append(item);
      continue;
    }

    closeList();
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, line.trim());
    container.append(paragraph);
  }
}

function tokenTotal(record) {
  return Math.max(0, Math.floor(record?.usage?.total_tokens || 0));
}

function dateKeyFromRecord(record) {
  return TimeUtils.dateKeyFromTimestamp(record.createdAt || Date.now());
}

function renderMiniBars(container, rows, emptyText) {
  container.textContent = "";
  const max = Math.max(...rows.map((row) => row.value), 0);
  if (!rows.length || !max) {
    const empty = document.createElement("p");
    empty.className = "emptyText";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    const label = document.createElement("span");
    const track = document.createElement("i");
    const fill = document.createElement("b");
    const value = document.createElement("strong");
    label.textContent = row.label;
    fill.style.width = `${Math.max(row.value ? 4 : 0, (row.value / max) * 100)}%`;
    value.textContent = String(row.value);
    track.append(fill);
    item.append(label, track, value);
    container.append(item);
  }
}

function renderTrend(container, dayCounts) {
  container.textContent = "";
  const entries = [...dayCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-14);
  const max = Math.max(...entries.map(([, count]) => count), 0);
  if (!entries.length || !max) {
    const empty = document.createElement("p");
    empty.className = "emptyText";
    empty.textContent = "Trend appears after page summaries are generated.";
    container.append(empty);
    return;
  }

  for (const [dateKey, count] of entries) {
    const bar = document.createElement("div");
    const column = document.createElement("i");
    const label = document.createElement("span");
    column.style.height = `${Math.max(8, (count / max) * 100)}%`;
    bar.title = `${dateKey}: ${count} summaries`;
    label.textContent = dateKey.slice(5);
    bar.append(column, label);
    container.append(bar);
  }
}

function renderInsights() {
  const reportItems = allReports();
  const summaries = Object.values(pageSummaries).flat();
  const doneSummaries = summaries.filter((item) => item.status === "done");
  const errors = summaries.filter((item) => item.status === "error");
  const lowEvidence = summaries.filter((item) => item.evidenceLevel === "low" || item.captureMethod === "metadata_only");
  const tokenCount = [...reportItems, ...summaries].reduce((sum, item) => sum + tokenTotal(item), 0);
  const topicCounts = new Map();
  const evidenceCounts = new Map();
  const methodCounts = new Map();
  const dayCounts = new Map();

  for (const summary of doneSummaries) {
    evidenceCounts.set(summary.evidenceLevel || "unknown", (evidenceCounts.get(summary.evidenceLevel || "unknown") || 0) + 1);
    methodCounts.set(summary.captureMethod || "unknown", (methodCounts.get(summary.captureMethod || "unknown") || 0) + 1);
    const dateKey = dateKeyFromRecord(summary);
    dayCounts.set(dateKey, (dayCounts.get(dateKey) || 0) + 1);

    for (const topic of summary.structuredSummary?.topics || []) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  }

  reportCountEl.textContent = String(reportItems.length);
  summaryCountEl.textContent = String(doneSummaries.length);
  tokenCountEl.textContent = tokenCount.toLocaleString();
  errorCountEl.textContent = String(errors.length);
  lowEvidenceCountEl.textContent = String(lowEvidence.length);

  renderMiniBars(evidenceBarsEl, [
    ...[...evidenceCounts.entries()].map(([label, value]) => ({ label, value })),
    ...[...methodCounts.entries()].map(([label, value]) => ({ label, value }))
  ], "Evidence quality appears after page summaries are generated.");
  renderTrend(summaryTrendEl, dayCounts);

  topicListEl.textContent = "";
  const topicEntries = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (!topicEntries.length) {
    const empty = document.createElement("p");
    empty.className = "emptyText";
    empty.textContent = "Topics appear after page summaries are generated.";
    topicListEl.append(empty);
  }
  for (const [topic, count] of topicEntries) {
    const row = document.createElement("div");
    const label = document.createElement("span");
    const value = document.createElement("strong");
    label.textContent = topic;
    value.textContent = String(count);
    row.append(label, value);
    topicListEl.append(row);
  }
}

function renderList() {
  reportListEl.textContent = "";
  const items = allReports();
  renderInsights();

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "eyebrow";
    empty.textContent = "No reports yet.";
    reportListEl.append(empty);
    return;
  }

  for (const report of items) {
    const button = document.createElement("button");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const preview = document.createElement("small");

    button.className = "reportItem";
    button.dataset.reportId = report.id;
    title.textContent = `${report.period}: ${report.startDate} - ${report.endDate}`;
    meta.textContent = `${new Date(report.createdAt).toLocaleString()}${report.usage?.total_tokens ? ` | ${report.usage.total_tokens.toLocaleString()} tokens` : ""}`;
    preview.textContent = report.backup?.local?.relativePath || report.backup?.local?.displayPath || report.backup?.remote?.remotePath
      ? report.backup.local?.relativePath || report.backup.local?.displayPath || report.backup.remote?.remotePath
      : String(report.report || "").replace(/\s+/g, " ").slice(0, 110);
    button.append(title, meta, preview);
    button.addEventListener("click", () => renderReport(report));
    reportListEl.append(button);
  }

  renderReport(items.find((item) => item.id === selectedReportId) || items[0]);
}

async function loadReports() {
  const data = await sendMessage({ type: "GET_ANALYSIS_DATA" });
  reports = data.analysisReports || {};
  pageSummaries = data.pageSummaries || {};
  analysisStatus = data.analysisStatus || null;
  renderAnalysisStatus();
  renderList();
}

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function renderAnalysisStatus() {
  if (activeRun) {
    analysisStatusEl.textContent = `${activeRun.label} running for ${formatElapsed(Date.now() - activeRun.startedAt)}...`;
    analysisStatusEl.className = "runStatus running";
    return;
  }

  if (!analysisStatus || analysisStatus.status === "none") {
    analysisStatusEl.textContent = "Ready.";
    analysisStatusEl.className = "runStatus";
    return;
  }

  const elapsed = analysisStatus.startedAt
    ? ` (${formatElapsed((analysisStatus.finishedAt || analysisStatus.at || Date.now()) - analysisStatus.startedAt)})`
    : "";
  analysisStatusEl.textContent = `${analysisStatus.status}: ${analysisStatus.reason || ""}${elapsed}`;
  analysisStatusEl.className = `runStatus ${analysisStatus.status}`;
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll("[data-period]").forEach((button) => {
    button.disabled = disabled;
  });
}

function startStatusTimer() {
  clearInterval(statusTimer);
  statusTimer = setInterval(renderAnalysisStatus, 1000);
}

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", async () => {
    const period = button.dataset.period;
    activeRun = {
      label: `${period[0].toUpperCase()}${period.slice(1)} analysis`,
      startedAt: Date.now()
    };
    setButtonsDisabled(true);
    startStatusTimer();
    renderAnalysisStatus();
    reportTitleEl.textContent = `${period[0].toUpperCase()}${period.slice(1)} Analysis`;
    reportMetaEl.textContent = "Running...";
    reportUsageEl.textContent = "Waiting for model";
    reportBackupEl.textContent = "Archive path appears after generation succeeds.";
    renderMarkdown(reportBodyEl, `Generating ${period} analysis.\n\nLarge date ranges can take a few minutes.`);
    try {
      const report = await sendMessage({
        type: "RUN_ANALYSIS",
        period,
        endDateKey: endDateEl.value
      });
      upsertReport(report);
      selectedReportId = report.id;
      const startedAt = activeRun?.startedAt;
      activeRun = null;
      analysisStatus = {
        status: "done",
        reason: `${period} analysis completed.`,
        startedAt,
        finishedAt: Date.now(),
        reportId: report.id
      };
      renderList();
      renderReport(report);
      renderAnalysisStatus();
    } catch (error) {
      activeRun = null;
      analysisStatus = {
        status: "error",
        reason: error.message || "Analysis failed.",
        finishedAt: Date.now()
      };
      reportBackupEl.textContent = "No backup path for failed analysis.";
      renderMarkdown(reportBodyEl, error.message || "Analysis failed.");
      renderAnalysisStatus();
    } finally {
      setButtonsDisabled(false);
    }
  });
});

endDateEl.value = TimeUtils.dateKeyFromTimestamp(Date.now());
loadReports();
