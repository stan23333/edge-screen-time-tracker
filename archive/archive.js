const kindFilterEl = document.getElementById("kindFilter");
const statusFilterEl = document.getElementById("statusFilter");
const dateFilterEl = document.getElementById("dateFilter");
const archiveSearchEl = document.getElementById("archiveSearch");
const refreshArchiveEl = document.getElementById("refreshArchive");
const flushPendingEl = document.getElementById("flushPending");
const archiveRowsEl = document.getElementById("archiveRows");
const localStatusEl = document.getElementById("localStatus");
const lastRunStatusEl = document.getElementById("lastRunStatus");
const metricTotalEl = document.getElementById("metricTotal");
const metricPendingEl = document.getElementById("metricPending");
const metricLocalIssuesEl = document.getElementById("metricLocalIssues");
const metricRemoteIssuesEl = document.getElementById("metricRemoteIssues");
const metricDeletedEl = document.getElementById("metricDeleted");

let archiveEntries = [];
let archiveLastRun = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (response?.error) {
      throw new Error(response.error);
    }
    return response;
  });
}

function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : "Never";
}

function sideStatus(side = {}) {
  return side.status || "pending";
}

function hasIssue(side = {}) {
  return ["pending", "error", "missing"].includes(sideStatus(side));
}

function entryText(entry) {
  return [
    entry.kind,
    entry.title,
    entry.dateKey,
    entry.reportId,
    entry.period,
    entry.relativePath,
    entry.local?.displayPath,
    entry.local?.folderPath,
    entry.local?.error,
    entry.local?.reason,
    entry.remote?.remotePath,
    entry.remote?.error,
    entry.remote?.reason
  ].join(" ").toLowerCase();
}

function filteredEntries() {
  const kind = kindFilterEl.value;
  const status = statusFilterEl.value;
  const date = dateFilterEl.value;
  const query = archiveSearchEl.value.trim().toLowerCase();
  return archiveEntries
    .filter((entry) => kind === "all" || entry.kind === kind)
    .filter((entry) => status === "all" || sideStatus(entry.local) === status || sideStatus(entry.remote) === status)
    .filter((entry) => !date || entry.dateKey === date || entry.relativePath?.includes(date))
    .filter((entry) => !query || entryText(entry).includes(query))
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

function renderMetrics() {
  const total = archiveEntries.length;
  const pending = archiveEntries.filter((entry) => sideStatus(entry.local) === "pending" || sideStatus(entry.remote) === "pending").length;
  const localIssues = archiveEntries.filter((entry) => hasIssue(entry.local)).length;
  const remoteIssues = archiveEntries.filter((entry) => hasIssue(entry.remote)).length;
  const deleted = archiveEntries.filter((entry) => sideStatus(entry.local) === "deleted" || sideStatus(entry.remote) === "deleted").length;

  metricTotalEl.textContent = String(total);
  metricPendingEl.textContent = String(pending);
  metricLocalIssuesEl.textContent = String(localIssues);
  metricRemoteIssuesEl.textContent = String(remoteIssues);
  metricDeletedEl.textContent = String(deleted);
}

function renderArchiveStatus(payload = {}) {
  const status = payload.archiveStatus?.localArchive || payload.localArchive || {};
  if (status.status === "granted") {
    localStatusEl.textContent = `Granted: ${status.name || "Selected folder"}`;
  } else if (status.status === "needs_reauthorize") {
    localStatusEl.textContent = status.reason || "Needs reauthorize";
  } else if (status.status === "write_failed") {
    localStatusEl.textContent = status.reason || "Write failed";
  } else {
    localStatusEl.textContent = "Not selected";
  }

  const run = payload.archiveLastRun || archiveLastRun || {};
  if (!run.at) {
    lastRunStatusEl.textContent = "No archive run yet.";
    return;
  }
  const summary = run.summary || {};
  lastRunStatusEl.textContent = `${formatTime(run.at)} · done ${summary.done || 0}, pending ${summary.pending || 0}, skipped ${summary.skipped || 0}, error ${summary.error || 0}`;
}

function statusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `statusBadge ${status || "pending"}`;
  badge.textContent = status || "pending";
  return badge;
}

function sideDetail(side = {}) {
  return side.error || side.reason || formatTime(side.backedUpAt || side.deletedAt || side.updatedAt);
}

async function copyText(text, button) {
  await navigator.clipboard.writeText(text);
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

async function runAction(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await task();
    await loadArchive();
  } catch (error) {
    button.textContent = error.message || "Failed";
    setTimeout(() => {
      button.disabled = false;
      button.textContent = original;
    }, 1600);
    return;
  }
  button.disabled = false;
  button.textContent = original;
}

async function openLocalEntryWithRepair(entry, button) {
  const previewWindow = window.open("about:blank", "_blank");
  if (previewWindow) {
    previewWindow.opener = null;
  }
  try {
    await LocalArchivePermission.openFile(entry.relativePath, previewWindow);
    return;
  } catch (error) {
    if (!LocalArchivePermission.isMissingFileError?.(error)) {
      if (previewWindow && !previewWindow.closed) {
        previewWindow.close();
      }
      throw error;
    }
  }

  button.textContent = "Re-archiving...";
  const retry = await sendMessage({
    type: "RETRY_ARCHIVE_ENTRIES",
    entryIds: [entry.id],
    targets: "local",
    trigger: "open_missing_local"
  });
  const failed = (retry.results || []).find((item) => item.target === "local" && item.status !== "done");
  if (failed) {
    if (previewWindow && !previewWindow.closed) {
      previewWindow.close();
    }
    throw new Error(failed.message || "Local archive file is missing and could not be rebuilt.");
  }
  button.textContent = "Opening...";
  try {
    await LocalArchivePermission.openFile(entry.relativePath, previewWindow);
  } catch (error) {
    if (previewWindow && !previewWindow.closed) {
      previewWindow.close();
    }
    throw error;
  }
}

function appendAction(parent, className, text, disabled, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.disabled = Boolean(disabled);
  button.addEventListener("click", () => handler(button));
  parent.append(button);
  return button;
}

function localFolderFromEntry(entry) {
  if (entry.local?.folderPath) {
    return entry.local.folderPath;
  }
  const parts = String(entry.relativePath || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function renderEntry(entry) {
  const row = document.createElement("article");
  const item = document.createElement("div");
  const local = document.createElement("div");
  const remote = document.createElement("div");
  const path = document.createElement("div");
  const actions = document.createElement("div");
  const title = document.createElement("strong");
  const meta = document.createElement("span");
  const localDetail = document.createElement("p");
  const remoteDetail = document.createElement("p");
  const pathText = document.createElement("p");

  row.className = "archiveRow";
  item.className = "archiveItem";
  actions.className = "rowActions";
  localDetail.className = sideStatus(entry.local) === "error" ? "errorText" : "pathText";
  remoteDetail.className = sideStatus(entry.remote) === "error" ? "errorText" : "pathText";
  pathText.className = "pathText";

  title.textContent = entry.title || entry.relativePath || entry.id;
  meta.textContent = `${entry.kind} · ${entry.dateKey || entry.period || "archive"} · updated ${formatTime(entry.updatedAt)}`;
  item.append(title, meta);

  local.append(statusBadge(sideStatus(entry.local)));
  localDetail.textContent = sideDetail(entry.local);
  local.append(localDetail);

  remote.append(statusBadge(sideStatus(entry.remote)));
  remoteDetail.textContent = sideDetail(entry.remote);
  remote.append(remoteDetail);

  pathText.textContent = entry.relativePath || entry.local?.relativePath || entry.remote?.relativePath || "";
  path.append(pathText);

  appendAction(actions, "actionLocal", "Open Local Folder", !entry.relativePath || sideStatus(entry.local) === "deleted", async (button) => {
    await copyText(localFolderFromEntry(entry), button);
  });
  appendAction(actions, "actionCopyFile", "Copy File Path", !(entry.local?.displayPath || entry.relativePath), async (button) => {
    await copyText(entry.local?.displayPath || entry.relativePath, button);
  });
  appendAction(actions, "actionCopyFolder", "Copy Folder Path", !localFolderFromEntry(entry), async (button) => {
    await copyText(localFolderFromEntry(entry), button);
  });
  appendAction(actions, "actionRemote", "Open Remote", !entry.remote?.remoteUrl || sideStatus(entry.remote) === "deleted", (button) => {
    if (entry.remote?.remoteUrl) {
      window.open(entry.remote.remoteUrl, "_blank", "noopener");
    }
    button.blur();
  });
  appendAction(actions, "actionLocal", "Re-archive Local", false, async (button) => {
    await runAction(button, "Writing...", async () => {
      await sendMessage({ type: "RETRY_ARCHIVE_ENTRIES", entryIds: [entry.id], targets: "local" });
    });
  });
  appendAction(actions, "actionRemote", "Upload Remote", false, async (button) => {
    await runAction(button, "Uploading...", async () => {
      await sendMessage({ type: "RETRY_ARCHIVE_ENTRIES", entryIds: [entry.id], targets: "remote" });
    });
  });
  appendAction(actions, "actionDelete", "Delete Local", sideStatus(entry.local) === "deleted", async (button) => {
    if (!window.confirm("Delete only the local archive file? App data and WebDAV remain.")) {
      return;
    }
    await runAction(button, "Deleting...", async () => {
      await sendMessage({ type: "DELETE_ARCHIVE_ENTRIES", entryIds: [entry.id], targets: "local" });
    });
  });
  appendAction(actions, "actionDelete", "Delete Remote", sideStatus(entry.remote) === "deleted", async (button) => {
    if (!window.confirm("Delete only the WebDAV archive file? App data and local file remain.")) {
      return;
    }
    await runAction(button, "Deleting...", async () => {
      await sendMessage({ type: "DELETE_ARCHIVE_ENTRIES", entryIds: [entry.id], targets: "remote" });
    });
  });
  appendAction(actions, "actionDelete", "Delete Both", sideStatus(entry.local) === "deleted" && sideStatus(entry.remote) === "deleted", async (button) => {
    if (!window.confirm("Delete both local and WebDAV archive files? App records and reports remain.")) {
      return;
    }
    await runAction(button, "Deleting...", async () => {
      await sendMessage({ type: "DELETE_ARCHIVE_ENTRIES", entryIds: [entry.id], targets: "both" });
    });
  });

  row.append(item, local, remote, path, actions);
  return row;
}

function renderRows() {
  archiveRowsEl.textContent = "";
  const rows = filteredEntries();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "No archive entries match the current filters.";
    archiveRowsEl.append(empty);
    return;
  }
  for (const entry of rows) {
    archiveRowsEl.append(renderEntry(entry));
  }
}

async function loadArchive() {
  const payload = await sendMessage({ type: "GET_ARCHIVE_INDEX" });
  archiveEntries = Object.values(payload.archiveIndex?.entries || {});
  archiveLastRun = payload.archiveLastRun || null;
  renderMetrics();
  renderArchiveStatus(payload);
  renderRows();
}

kindFilterEl.addEventListener("change", renderRows);
statusFilterEl.addEventListener("change", renderRows);
dateFilterEl.addEventListener("change", renderRows);
archiveSearchEl.addEventListener("input", renderRows);

refreshArchiveEl.addEventListener("click", async () => {
  await runAction(refreshArchiveEl, "Refreshing...", loadArchive);
});

flushPendingEl.addEventListener("click", async () => {
  await runAction(flushPendingEl, "Flushing...", async () => {
    await sendMessage({ type: "FLUSH_LOCAL_ARCHIVE_PENDING" });
  });
});

loadArchive().catch((error) => {
  archiveRowsEl.textContent = "";
  const empty = document.createElement("p");
  empty.className = "emptyState";
  empty.textContent = error.message || "Archive index could not be loaded.";
  archiveRowsEl.append(empty);
});
