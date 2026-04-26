const datePickerEl = document.getElementById("datePicker");
const totalTimeEl = document.getElementById("totalTime");
const secondaryTimeEl = document.getElementById("secondaryTime");
const longestSiteEl = document.getElementById("longestSite");
const longestTimeEl = document.getElementById("longestTime");
const siteCountEl = document.getElementById("siteCount");
const trackingModeEl = document.getElementById("trackingMode");
const timezoneLabelEl = document.getElementById("timezoneLabel");
const chartMetricEl = document.getElementById("chartMetric");
const barChartEl = document.getElementById("barChart");
const siteTableEl = document.getElementById("siteTable");
const emptyStateEl = document.getElementById("emptyState");
const exportJsonEl = document.getElementById("exportJson");
const clearDateEl = document.getElementById("clearDate");
const donutEl = document.getElementById("donut");
const donutDomainEl = document.getElementById("donutDomain");
const donutShareEl = document.getElementById("donutShare");
const activeHeatmapEl = document.getElementById("activeHeatmap");
const openHeatmapEl = document.getElementById("openHeatmap");
const siteHeatmapEl = document.getElementById("siteHeatmap");
const selectedSiteTitleEl = document.getElementById("selectedSiteTitle");
const selectedSiteTotalEl = document.getElementById("selectedSiteTotal");
const ignoreSelectedSiteEl = document.getElementById("ignoreSelectedSite");

const DAY_MS = 24 * 60 * 60 * 1000;
const HEATMAP_DAYS = 120;

let snapshot = null;
let selectedSite = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function selectedDateKey() {
  return datePickerEl.value || TimeUtils.dateKeyFromTimestamp(Date.now());
}

function normalizeEntry(value) {
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

function rowsForDate(dateKey) {
  const day = snapshot?.dailyStats?.[dateKey] || {};
  return Object.entries(day)
    .map(([domain, value]) => ({
      domain,
      ...normalizeEntry(value)
    }))
    .sort((a, b) => b.activeSeconds - a.activeSeconds || b.openSeconds - a.openSeconds);
}

function allDateKeys() {
  return Object.keys(snapshot?.dailyStats || {}).sort();
}

function totalForDate(dateKey, targetMetric, domain = null) {
  const day = snapshot?.dailyStats?.[dateKey] || {};

  if (domain) {
    return normalizeEntry(day[domain])[targetMetric];
  }

  return Object.values(day).reduce((sum, value) => sum + normalizeEntry(value)[targetMetric], 0);
}

function timestampFromDateKey(dateKey) {
  const parts = dateKey.split("-").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    return Number.NaN;
  }

  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

function recentDateKeys() {
  const end = timestampFromDateKey(selectedDateKey());
  if (Number.isNaN(end)) {
    return [];
  }

  const keys = [];
  for (let index = HEATMAP_DAYS - 1; index >= 0; index -= 1) {
    keys.push(TimeUtils.dateKeyFromTimestamp(end - index * DAY_MS));
  }
  return keys;
}

function heatLevel(value, max) {
  if (!value || !max) {
    return 0;
  }

  const ratio = value / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.45) return 3;
  if (ratio >= 0.2) return 2;
  return 1;
}

function renderHeatmap(container, values, label) {
  container.textContent = "";
  const max = Math.max(...values.map((item) => item.seconds), 0);

  for (const item of values) {
    const cell = document.createElement("span");
    const level = heatLevel(item.seconds, max);
    cell.className = `heatCell level${level}`;
    cell.title = `${item.date}: ${TimeUtils.formatDuration(item.seconds)} ${label}`;
    container.append(cell);
  }
}

function renderAllHeatmaps() {
  const dates = recentDateKeys();
  const activeValues = dates.map((date) => ({
    date,
    seconds: totalForDate(date, "activeSeconds")
  }));
  const openValues = dates.map((date) => ({
    date,
    seconds: totalForDate(date, "openSeconds")
  }));
  const siteValues = dates.map((date) => ({
    date,
    seconds: selectedSite ? totalForDate(date, "activeSeconds", selectedSite) : 0
  }));
  const siteActiveTotal = siteValues.reduce((sum, item) => sum + item.seconds, 0);
  const siteOpenTotal = selectedSite
    ? dates.reduce((sum, date) => sum + totalForDate(date, "openSeconds", selectedSite), 0)
    : 0;

  renderHeatmap(activeHeatmapEl, activeValues, "active");
  renderHeatmap(openHeatmapEl, openValues, "open");
  renderHeatmap(siteHeatmapEl, siteValues, selectedSite ? "active" : "site");

  selectedSiteTitleEl.textContent = selectedSite || "Select a Site";
  selectedSiteTotalEl.textContent = selectedSite
    ? `${TimeUtils.formatClockSeconds(siteActiveTotal)} / ${TimeUtils.formatClockSeconds(siteOpenTotal)}`
    : "00:00:00";
  ignoreSelectedSiteEl.disabled = !selectedSite;
}

function renderBars(rows, maxOpenSeconds) {
  barChartEl.textContent = "";

  for (const row of rows.slice(0, 10)) {
    const item = document.createElement("div");
    const label = document.createElement("div");
    const track = document.createElement("div");
    const openFill = document.createElement("div");
    const activeFill = document.createElement("div");
    const time = document.createElement("div");
    const openWidth = (row.openSeconds / Math.max(maxOpenSeconds, 1)) * 100;
    const activeWidth = (row.activeSeconds / Math.max(maxOpenSeconds, 1)) * 100;

    item.className = "barRow";
    label.className = "barLabel";
    track.className = "barTrack";
    openFill.className = "barFill barFillOpen";
    activeFill.className = "barFill barFillActive";
    time.className = "barTime";

    label.textContent = row.domain;
    openFill.style.width = `${Math.max(row.openSeconds ? 2 : 0, openWidth)}%`;
    activeFill.style.width = `${Math.max(row.activeSeconds ? 2 : 0, activeWidth)}%`;
    time.textContent = `${TimeUtils.formatDuration(row.activeSeconds)} / ${TimeUtils.formatDuration(row.openSeconds)}`;
    track.title = `Active ${TimeUtils.formatDuration(row.activeSeconds)} / Open ${TimeUtils.formatDuration(row.openSeconds)}`;

    track.append(openFill, activeFill);
    item.append(label, track, time);
    barChartEl.append(item);
  }
}

function renderDonut(rows, totalActiveSeconds) {
  const top = rows[0];
  const share = top && totalActiveSeconds ? Math.round((top.activeSeconds / totalActiveSeconds) * 100) : 0;
  const degrees = Math.round((share / 100) * 360);

  donutEl.style.background = `conic-gradient(var(--green) ${degrees}deg, #e7edf5 ${degrees}deg)`;
  donutDomainEl.textContent = top?.domain || "None";
  donutShareEl.textContent = `${share}%`;
}

function renderTable(rows, activeTotal) {
  siteTableEl.textContent = "";

  for (const row of rows) {
    const tr = document.createElement("tr");
    const domain = document.createElement("td");
    const active = document.createElement("td");
    const open = document.createElement("td");
    const share = document.createElement("td");
    const activeShare = activeTotal ? Math.round((row.activeSeconds / activeTotal) * 100) : 0;

    if (row.domain === selectedSite) {
      tr.className = "selected";
    }

    domain.textContent = row.domain;
    active.textContent = TimeUtils.formatClockSeconds(row.activeSeconds);
    open.textContent = TimeUtils.formatClockSeconds(row.openSeconds);
    share.textContent = `${activeShare}%`;

    tr.addEventListener("click", () => {
      selectedSite = row.domain;
      render();
    });

    tr.append(domain, active, open, share);
    siteTableEl.append(tr);
  }
}

function selectFallbackSite(rows) {
  if (selectedSite && rows.some((row) => row.domain === selectedSite)) {
    return;
  }

  selectedSite = rows[0]?.domain || null;
}

function render() {
  const rows = rowsForDate(selectedDateKey());
  const activeTotal = rows.reduce((sum, row) => sum + row.activeSeconds, 0);
  const openTotal = rows.reduce((sum, row) => sum + row.openSeconds, 0);
  const maxOpenSeconds = Math.max(...rows.map((row) => row.openSeconds), 0);
  const longest = rows[0];

  selectFallbackSite(rows);

  totalTimeEl.textContent = TimeUtils.formatClockSeconds(activeTotal);
  secondaryTimeEl.textContent = "Focused browsing time";
  longestSiteEl.textContent = longest?.domain || "None";
  longestTimeEl.textContent = longest
    ? `${TimeUtils.formatClockSeconds(longest.activeSeconds)} / ${TimeUtils.formatClockSeconds(longest.openSeconds)}`
    : "00:00:00";
  siteCountEl.textContent = String(rows.length);
  trackingModeEl.textContent = "Active usage";
  timezoneLabelEl.textContent = `Timezone: ${snapshot.timezone || TimeUtils.systemTimeZone()}`;
  chartMetricEl.textContent = "Active ranked";
  emptyStateEl.style.display = rows.length ? "none" : "block";

  renderBars(rows, maxOpenSeconds);
  renderDonut(rows, activeTotal);
  renderTable(rows, activeTotal);
  renderAllHeatmaps();
}

async function refresh() {
  snapshot = await sendMessage({ type: "GET_SNAPSHOT" });
  if (!datePickerEl.value) {
    datePickerEl.value = snapshot.todayKey;
  }
  render();
}

datePickerEl.addEventListener("change", render);

exportJsonEl.addEventListener("click", async () => {
  const payload = await sendMessage({ type: "EXPORT_FULL_DATA" });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `web-screen-time-full-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

clearDateEl.addEventListener("click", async () => {
  const dateKey = selectedDateKey();
  const confirmed = confirm(`Clear all data for ${dateKey}?`);
  if (!confirmed) {
    return;
  }

  snapshot = await sendMessage({ type: "CLEAR_DATE", dateKey });
  selectedSite = null;
  render();
});

ignoreSelectedSiteEl.addEventListener("click", async () => {
  if (!selectedSite) {
    return;
  }

  const confirmed = confirm(`Ignore ${selectedSite} from future tracking and analysis?`);
  if (!confirmed) {
    return;
  }

  await sendMessage({ type: "IGNORE_DOMAIN", domain: selectedSite });
  selectedSite = null;
  await refresh();
});

refresh();
setInterval(refresh, 5000);
