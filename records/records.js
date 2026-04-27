const endDateEl = document.getElementById("endDate");
const refreshDataEl = document.getElementById("refreshData");
const exportDataEl = document.getElementById("exportData");
const siteBarsEl = document.getElementById("siteBars");
const emptyStateEl = document.getElementById("emptyState");
const selectedDomainEl = document.getElementById("selectedDomain");
const clearSelectionEl = document.getElementById("clearSelection");
const visitListEl = document.getElementById("visitList");
const summaryJsonEl = document.getElementById("summaryJson");
const summaryTitleEl = document.getElementById("summaryTitle");
const openTotalEl = document.getElementById("openTotal");
const activeTotalEl = document.getElementById("activeTotal");
const summaryTotalEl = document.getElementById("summaryTotal");
const tokenTotalEl = document.getElementById("tokenTotal");
const tokenRingEl = document.getElementById("tokenRing");
const timezoneLabelEl = document.getElementById("timezoneLabel");
const summaryTokensEl = document.getElementById("summaryTokens");
const analysisTokensEl = document.getElementById("analysisTokens");
const llmEmptyStateEl = document.getElementById("llmEmptyState");
const summaryDiagnosticEl = document.getElementById("summaryDiagnostic");
const requestCountEl = document.getElementById("requestCount");
const pendingCountEl = document.getElementById("pendingCount");
const capturingCountEl = document.getElementById("capturingCount");
const summarizingCountEl = document.getElementById("summarizingCount");
const doneCountEl = document.getElementById("doneCount");
const errorCountEl = document.getElementById("errorCount");
const unknownUsageCountEl = document.getElementById("unknownUsageCount");
const dailyTrendEl = document.getElementById("dailyTrend");
const captureMixEl = document.getElementById("captureMix");

const DAY_MS = 24 * 60 * 60 * 1000;
let snapshot = null;
let rangeDays = 1;
let selectedDomain = null;
let selectedVisitId = null;
let selectedSummaryId = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (response?.error) {
      throw new Error(response.error);
    }
    return response;
  });
}

function dateToKey(date) {
  return TimeUtils.dateKeyFromTimestamp(date.getTime());
}

function keyToDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(year, month - 1, day);
}

function rangeKeys() {
  const end = endDateEl.value ? keyToDate(endDateEl.value) : new Date();
  const keys = [];
  for (let index = rangeDays - 1; index >= 0; index -= 1) {
    keys.push(dateToKey(new Date(end.getTime() - index * DAY_MS)));
  }
  return keys;
}

function normalizeEntry(value) {
  if (typeof value === "number") {
    return { activeSeconds: value, openSeconds: 0 };
  }
  return {
    activeSeconds: Math.max(0, Math.floor(value?.activeSeconds || 0)),
    openSeconds: Math.max(0, Math.floor(value?.openSeconds || 0))
  };
}

function usageTotal(record) {
  return Math.max(0, Math.floor(record?.usage?.total_tokens || 0));
}

function allSummaries() {
  return Object.values(snapshot?.pageSummaries || {}).flat();
}

function allReports() {
  return Object.values(snapshot?.analysisReports || {}).flat();
}

function summaryMap() {
  return new Map(allSummaries().map((summary) => [summary.id, summary]));
}

function rowsForRange(keys) {
  const rows = new Map();
  for (const key of keys) {
    const day = snapshot?.dailyStats?.[key] || {};
    for (const [domain, value] of Object.entries(day)) {
      const current = rows.get(domain) || {
        domain,
        activeSeconds: 0,
        openSeconds: 0,
        visits: 0,
        summaries: 0,
        errors: 0,
        tokens: 0
      };
      const entry = normalizeEntry(value);
      current.activeSeconds += entry.activeSeconds;
      current.openSeconds += entry.openSeconds;
      rows.set(domain, current);
    }

    for (const visit of snapshot?.visitEvents?.[key] || []) {
      const current = rows.get(visit.domain) || {
        domain: visit.domain,
        activeSeconds: 0,
        openSeconds: 0,
        visits: 0,
        summaries: 0,
        errors: 0,
        tokens: 0
      };
      current.visits += 1;
      rows.set(visit.domain, current);
    }

    for (const summary of snapshot?.pageSummaries?.[key] || []) {
      const current = rows.get(summary.domain) || {
        domain: summary.domain,
        activeSeconds: 0,
        openSeconds: 0,
        visits: 0,
        summaries: 0,
        errors: 0,
        tokens: 0
      };
      current.summaries += summary.status === "done" ? 1 : 0;
      current.errors += summary.status === "error" ? 1 : 0;
      current.tokens += usageTotal(summary);
      rows.set(summary.domain, current);
    }
  }

  return [...rows.values()].sort((a, b) => b.openSeconds - a.openSeconds || b.activeSeconds - a.activeSeconds);
}

function summariesForRange(keys) {
  return keys.flatMap((key) => snapshot?.pageSummaries?.[key] || []);
}

function reportsForRange(keys) {
  const allowed = new Set(keys);
  return allReports().filter((report) => allowed.has(report.endDate) || allowed.has(TimeUtils.dateKeyFromTimestamp(report.createdAt)));
}

function visitsForRange(keys) {
  const summaries = summaryMap();
  return keys
    .flatMap((key) => snapshot?.visitEvents?.[key] || [])
    .filter((visit) => !selectedDomain || visit.domain === selectedDomain)
    .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
    .map((visit) => ({
      ...visit,
      summary: visit.summaryId ? summaries.get(visit.summaryId) : null
    }));
}

function findSummaryById(summaryId) {
  if (!summaryId) {
    return null;
  }

  return summaryMap().get(summaryId) || null;
}

function findVisitById(visits, visitId) {
  if (!visitId) {
    return null;
  }

  return visits.find((visit) => visit.id === visitId) || null;
}

function renderMetrics(rows, summaries, reports) {
  const openTotal = rows.reduce((sum, row) => sum + row.openSeconds, 0);
  const activeTotal = rows.reduce((sum, row) => sum + row.activeSeconds, 0);
  const summaryTokens = summaries.reduce((sum, summary) => sum + usageTotal(summary), 0);
  const analysisTokens = reports.reduce((sum, report) => sum + usageTotal(report), 0);
  const tokenTotal = summaryTokens + analysisTokens;
  const summaryShare = tokenTotal ? Math.round((summaryTokens / tokenTotal) * 360) : 0;
  const statusCount = (status) => summaries.filter((item) => item.status === status).length;
  const requestCount = summaries.length + reports.length;

  openTotalEl.textContent = TimeUtils.formatClockSeconds(openTotal);
  activeTotalEl.textContent = TimeUtils.formatClockSeconds(activeTotal);
  summaryTotalEl.textContent = String(summaries.filter((item) => item.status === "done").length);
  tokenTotalEl.textContent = tokenTotal.toLocaleString();
  summaryTokensEl.textContent = summaryTokens.toLocaleString();
  analysisTokensEl.textContent = analysisTokens.toLocaleString();
  requestCountEl.textContent = String(requestCount);
  pendingCountEl.textContent = String(statusCount("pending"));
  capturingCountEl.textContent = String(statusCount("capturing"));
  summarizingCountEl.textContent = String(statusCount("summarizing"));
  doneCountEl.textContent = String(statusCount("done"));
  errorCountEl.textContent = String(statusCount("error"));
  unknownUsageCountEl.textContent = String(summaries.filter((item) => item.status === "done" && !item.usage).length);
  llmEmptyStateEl.style.display = requestCount ? "none" : "block";
  renderSummaryDiagnostic();
  tokenRingEl.style.background = `conic-gradient(var(--purple) ${summaryShare}deg, var(--peach) ${summaryShare}deg 360deg)`;
}

function renderSummaryDiagnostic() {
  const diagnostics = snapshot?.summaryDiagnostics;
  if (!diagnostics) {
    summaryDiagnosticEl.textContent = "Summary diagnostics unavailable.";
    return;
  }

  const parts = [
    diagnostics.autoSummarize ? "Auto summary: on" : "Auto summary: off",
    diagnostics.modelConfigured ? "Model: configured" : "Model: not configured"
  ];
  const last = diagnostics.lastSummaryStatus;
  if (last?.status) {
    parts.push(`Last: ${last.status} - ${last.reason || ""}`);
  }

  summaryDiagnosticEl.textContent = parts.join(" | ");
}

function renderBars(rows) {
  siteBarsEl.textContent = "";
  emptyStateEl.style.display = rows.length ? "none" : "block";
  const maxOpen = Math.max(...rows.map((row) => row.openSeconds), 0);

  for (const row of rows.slice(0, 14)) {
    const item = document.createElement("div");
    const label = document.createElement("div");
    const track = document.createElement("div");
    const open = document.createElement("div");
    const active = document.createElement("div");
    const time = document.createElement("div");

    item.className = `barRow${row.domain === selectedDomain ? " selected" : ""}`;
    label.className = "barLabel";
    track.className = "barTrack";
    open.className = "barOpen";
    active.className = "barActive";
    time.className = "barTime";

    label.textContent = row.domain;
    open.style.width = `${Math.max(row.openSeconds ? 2 : 0, (row.openSeconds / Math.max(maxOpen, 1)) * 100)}%`;
    active.style.width = `${Math.max(row.activeSeconds ? 2 : 0, (row.activeSeconds / Math.max(maxOpen, 1)) * 100)}%`;
    time.textContent = `${TimeUtils.formatDuration(row.activeSeconds)} / ${TimeUtils.formatDuration(row.openSeconds)}`;
    item.title = `${row.visits} visits, ${row.summaries} summaries, ${row.tokens.toLocaleString()} tokens`;
    item.addEventListener("click", () => {
      selectedDomain = row.domain;
      render();
    });

    track.append(open, active);
    item.append(label, track, time);
    siteBarsEl.append(item);
  }
}

function renderDailyTrend(keys) {
  dailyTrendEl.textContent = "";
  const rows = keys.map((key) => {
    const day = snapshot?.dailyStats?.[key] || {};
    const totals = Object.values(day).reduce((sum, entry) => {
      const normalized = normalizeEntry(entry);
      sum.active += normalized.activeSeconds;
      sum.open += normalized.openSeconds;
      return sum;
    }, { active: 0, open: 0 });
    return { key, ...totals };
  });
  const max = Math.max(...rows.map((row) => row.open || row.active), 0);
  if (!max) {
    const empty = document.createElement("p");
    empty.className = "emptyInline";
    empty.textContent = "No daily trend for this range.";
    dailyTrendEl.append(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    const stack = document.createElement("span");
    const open = document.createElement("i");
    const active = document.createElement("b");
    const label = document.createElement("em");
    open.style.height = `${Math.max(row.open ? 8 : 0, (row.open / max) * 100)}%`;
    active.style.height = `${Math.max(row.active ? 8 : 0, (row.active / max) * 100)}%`;
    label.textContent = row.key.slice(5);
    item.title = `${row.key}: active ${TimeUtils.formatDuration(row.active)}, open ${TimeUtils.formatDuration(row.open)}`;
    stack.append(open, active);
    item.append(stack, label);
    dailyTrendEl.append(item);
  }
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function renderMixBars(summaries) {
  captureMixEl.textContent = "";
  const counts = new Map();
  for (const summary of summaries) {
    increment(counts, `status:${summary.status || "unknown"}`);
    if (summary.status === "done") {
      increment(counts, `method:${summary.captureMethod || "unknown"}`);
      increment(counts, `evidence:${summary.evidenceLevel || "unknown"}`);
      increment(counts, `type:${summary.structuredSummary?.contentType || "other"}`);
    }
  }

  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const max = Math.max(...rows.map(([, count]) => count), 0);
  if (!rows.length || !max) {
    const empty = document.createElement("p");
    empty.className = "emptyInline";
    empty.textContent = "Capture mix appears after summaries are generated.";
    captureMixEl.append(empty);
    return;
  }

  for (const [labelText, count] of rows) {
    const row = document.createElement("div");
    const label = document.createElement("span");
    const track = document.createElement("i");
    const fill = document.createElement("b");
    const value = document.createElement("strong");
    label.textContent = labelText;
    fill.style.width = `${Math.max(4, (count / max) * 100)}%`;
    value.textContent = String(count);
    track.append(fill);
    row.append(label, track, value);
    captureMixEl.append(row);
  }
}

function renderVisits(visits) {
  visitListEl.textContent = "";
  selectedDomainEl.textContent = selectedDomain || "All websites";

  if (!visits.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.style.display = "block";
    empty.textContent = "No visits for this selection.";
    visitListEl.append(empty);
    return;
  }

  for (const visit of visits.slice(0, 80)) {
    const item = document.createElement("article");
    const button = document.createElement("button");
    const title = document.createElement("span");
    const meta = document.createElement("span");
    const pill = document.createElement("span");
    const opened = visit.openedAt ? new Date(visit.openedAt).toLocaleString() : "Unknown time";

    item.className = "visitItem";
    title.className = "visitTitle";
    meta.className = "visitMeta";
    pill.className = `statusPill ${visit.summary?.status || visit.summaryStatus || "none"}`;
    title.textContent = visit.title || visit.domain;
    const capture = visit.summary?.captureMethod
      ? ` | ${visit.summary.captureMethod}/${visit.summary.evidenceLevel || "unknown"}`
      : "";
    meta.textContent = `${opened} | ${visit.domain} | Active ${TimeUtils.formatDuration(visit.activeSeconds || 0)} | Open ${TimeUtils.formatDuration(visit.openSeconds || 0)}${capture}`;
    pill.textContent = visit.summary?.status || visit.summaryStatus || "none";
    button.append(title, meta, pill);
    button.addEventListener("click", () => {
      selectedVisitId = visit.id;
      selectedSummaryId = visit.summaryId || null;
      renderSummary(visit.summary, visit);
    });
    item.append(button);
    visitListEl.append(item);
  }
}

function renderSummary(summary, visit = null) {
  summaryTitleEl.textContent = summary?.title || visit?.title || "Latest summary";
  if (!summary) {
    const diagnostics = snapshot?.summaryDiagnostics;
    const reason = !diagnostics?.autoSummarize
      ? "Auto summarize is turned off."
      : !diagnostics?.modelConfigured
        ? "Summary model is not fully configured."
        : visit?.summaryStatus && visit.summaryStatus !== "none"
          ? `Summary status is ${visit.summaryStatus}.`
          : diagnostics?.lastSummaryStatus?.reason || "No summary task was created for this visit yet.";
    summaryJsonEl.textContent = reason;
    return;
  }

  summaryJsonEl.textContent = JSON.stringify({
    id: summary.id,
    createdAt: summary.createdAt,
    domain: summary.domain,
    url: summary.url,
    title: summary.title,
    status: summary.status,
    captureMethod: summary.captureMethod || "unknown",
    captureStatus: summary.captureStatus || "unknown",
    evidenceLevel: summary.evidenceLevel || "unknown",
    sourceCharCount: summary.sourceCharCount || 0,
    screenshotCapturedAt: summary.screenshotCapturedAt || null,
    usage: summary.usage || "not reported",
    structuredSummary: summary.structuredSummary,
    captureError: summary.captureError || "",
    error: summary.error || ""
  }, null, 2);
}

function render() {
  const keys = rangeKeys();
  timezoneLabelEl.textContent = `Timezone: ${snapshot?.timezone || TimeUtils.systemTimeZone()}`;
  const rows = rowsForRange(keys);
  const summaries = summariesForRange(keys);
  const reports = reportsForRange(keys);
  const visits = visitsForRange(keys);

  renderMetrics(rows, summaries, reports);
  renderBars(rows);
  renderDailyTrend(keys);
  renderMixBars(summaries);
  renderVisits(visits);

  const selectedVisit = findVisitById(visits, selectedVisitId);
  const selectedSummary = findSummaryById(selectedSummaryId) || selectedVisit?.summary || null;
  if (selectedVisit || selectedSummary) {
    renderSummary(selectedSummary, selectedVisit);
    return;
  }

  if (selectedVisitId || selectedSummaryId) {
    selectedVisitId = null;
    selectedSummaryId = null;
  }

  const latestDoneSummary = summaries
    .filter((summary) => summary.status === "done")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const latestAnySummary = summaries
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  renderSummary(latestDoneSummary || latestAnySummary || null);
}

async function refresh() {
  snapshot = await sendMessage({ type: "GET_RECORDS_DATA" });
  render();
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

document.querySelectorAll("[data-range]").forEach((button) => {
  button.addEventListener("click", () => {
    rangeDays = Number.parseInt(button.dataset.range, 10) || 1;
    document.querySelectorAll("[data-range]").forEach((item) => item.classList.toggle("active", item === button));
    selectedDomain = null;
    selectedVisitId = null;
    selectedSummaryId = null;
    render();
  });
});

endDateEl.addEventListener("change", () => {
  selectedDomain = null;
  selectedVisitId = null;
  selectedSummaryId = null;
  render();
});

clearSelectionEl.addEventListener("click", () => {
  selectedDomain = null;
  selectedVisitId = null;
  selectedSummaryId = null;
  render();
});

refreshDataEl.addEventListener("click", refresh);

exportDataEl.addEventListener("click", async () => {
  downloadJson(`browser-tracker-records-${new Date().toISOString().slice(0, 10)}.json`, await sendMessage({ type: "EXPORT_FULL_DATA" }));
});

endDateEl.value = TimeUtils.dateKeyFromTimestamp(Date.now());
refresh();
setInterval(refresh, 2000);
