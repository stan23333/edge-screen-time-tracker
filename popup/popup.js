const totalTimeEl = document.getElementById("totalTime");
const activeTotalEl = document.getElementById("activeTotal");
const chartRatioEl = document.getElementById("chartRatio");
const usageRingEl = document.getElementById("usageRing");
const ringRatioEl = document.getElementById("ringRatio");
const openProgressTextEl = document.getElementById("openProgressText");
const activeProgressTextEl = document.getElementById("activeProgressText");
const openProgressBarEl = document.getElementById("openProgressBar");
const activeProgressBarEl = document.getElementById("activeProgressBar");
const statusBadgeEl = document.getElementById("statusBadge");
const timezoneLabelEl = document.getElementById("timezoneLabel");
const currentDomainEl = document.getElementById("currentDomain");
const currentTimeEl = document.getElementById("currentTime");
const currentOpenTimeEl = document.getElementById("currentOpenTime");
const topSitesEl = document.getElementById("topSites");
const emptyStateEl = document.getElementById("emptyState");
const ignoreCurrentSiteEl = document.getElementById("ignoreCurrentSite");
const ignoreMenuEl = document.getElementById("ignoreMenu");
const ignoreThisTimeEl = document.getElementById("ignoreThisTime");
const ignoreAllTimeEl = document.getElementById("ignoreAllTime");
const openDashboardEl = document.getElementById("openDashboard");

let snapshot = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function renderTopSites(topSites) {
  topSitesEl.textContent = "";
  const sites = [...topSites]
    .sort((a, b) => (b.openSeconds || 0) - (a.openSeconds || 0) || (b.activeSeconds || 0) - (a.activeSeconds || 0))
    .slice(0, 2);

  emptyStateEl.style.display = sites.length ? "none" : "block";

  for (const site of sites) {
    const item = document.createElement("li");
    const domain = document.createElement("span");
    const times = document.createElement("span");

    domain.className = "domain";
    times.className = "duration";
    domain.textContent = site.domain;
    times.textContent = `${TimeUtils.formatDuration(site.openSeconds)} | ${TimeUtils.formatDuration(site.activeSeconds)}`;

    item.append(domain, times);
    topSitesEl.append(item);
  }
}

function render(nextSnapshot) {
  snapshot = nextSnapshot;
  const currentDomain = snapshot.activeSession?.domain || "No active site";
  const currentEntry = snapshot.today?.[snapshot.activeSession?.domain] || {};
  const currentSeconds = typeof currentEntry === "number"
    ? currentEntry
    : currentEntry.activeSeconds || 0;
  const currentOpenSeconds = typeof currentEntry === "number"
    ? 0
    : currentEntry.openSeconds || 0;
  const totalActiveSeconds = snapshot.totalActiveSeconds || snapshot.totalSeconds || 0;
  const totalOpenSeconds = snapshot.totalOpenSeconds || totalActiveSeconds;
  const currentShare = totalActiveSeconds ? Math.round((currentSeconds / totalActiveSeconds) * 100) : 0;
  const currentActiveOpenRatio = currentOpenSeconds ? Math.round((currentSeconds / currentOpenSeconds) * 100) : 0;

  totalTimeEl.textContent = TimeUtils.formatClockSeconds(totalActiveSeconds);
  activeTotalEl.textContent = TimeUtils.formatClockSeconds(currentSeconds);
  openProgressTextEl.textContent = TimeUtils.formatClockSeconds(currentOpenSeconds);
  activeProgressTextEl.textContent = TimeUtils.formatClockSeconds(currentSeconds);
  openProgressBarEl.style.width = currentOpenSeconds ? "100%" : "0%";
  activeProgressBarEl.style.width = `${Math.max(currentSeconds ? 2 : 0, currentActiveOpenRatio)}%`;
  timezoneLabelEl.textContent = `Timezone: ${snapshot.timezone || TimeUtils.systemTimeZone()}`;
  chartRatioEl.textContent = `${currentShare}%`;
  ringRatioEl.textContent = `${currentShare}%`;
  usageRingEl.style.background = `conic-gradient(#2fd36b ${Math.round((currentShare / 100) * 360)}deg, #334155 ${Math.round((currentShare / 100) * 360)}deg)`;
  currentDomainEl.textContent = currentDomain;
  currentOpenTimeEl.textContent = `Open ${TimeUtils.formatClockSeconds(currentOpenSeconds)}`;
  currentTimeEl.textContent = `Active ${TimeUtils.formatClockSeconds(currentSeconds)}`;
  ignoreCurrentSiteEl.disabled = !snapshot.activeSession?.domain;
  statusBadgeEl.textContent = snapshot.trackingPaused
    ? "Paused"
    : snapshot.idleState === "locked"
      ? "Locked"
      : "Active";
  statusBadgeEl.classList.toggle("paused", snapshot.trackingPaused || snapshot.idleState === "locked");
  renderTopSites(snapshot.topSites || []);
}

async function refresh() {
  render(await sendMessage({ type: "GET_SNAPSHOT" }));
}

ignoreCurrentSiteEl.addEventListener("click", () => {
  ignoreMenuEl.hidden = !ignoreMenuEl.hidden;
});

ignoreThisTimeEl.addEventListener("click", async () => {
  ignoreMenuEl.hidden = true;
  await sendMessage({ type: "IGNORE_CURRENT_VISIT" });
  await refresh();
});

ignoreAllTimeEl.addEventListener("click", async () => {
  const domain = snapshot?.activeSession?.domain;
  if (!domain) {
    return;
  }

  const confirmed = confirm(`Ignore all time for ${domain}?`);
  if (!confirmed) {
    return;
  }

  ignoreMenuEl.hidden = true;
  await sendMessage({
    type: "IGNORE_DOMAIN",
    domain,
    tabId: snapshot.activeSession?.tabId
  });
  await refresh();
});

openDashboardEl.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
});

refresh();
setInterval(refresh, 1000);
