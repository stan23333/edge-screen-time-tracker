const endDateEl = document.getElementById("endDate");
const reportListEl = document.getElementById("reportList");
const reportMetaEl = document.getElementById("reportMeta");
const reportTitleEl = document.getElementById("reportTitle");
const reportBodyEl = document.getElementById("reportBody");
const reportUsageEl = document.getElementById("reportUsage");
const reportCountEl = document.getElementById("reportCount");
const summaryCountEl = document.getElementById("summaryCount");
const tokenCountEl = document.getElementById("tokenCount");
const errorCountEl = document.getElementById("errorCount");
const contentTypesEl = document.getElementById("contentTypes");
const topicListEl = document.getElementById("topicList");

let reports = {};
let pageSummaries = {};

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

function renderReport(report) {
  reportMetaEl.textContent = `${report.period} | ${report.startDate} to ${report.endDate} | ${new Date(report.createdAt).toLocaleString()}`;
  reportTitleEl.textContent = `${report.period[0].toUpperCase()}${report.period.slice(1)} Analysis`;
  reportBodyEl.textContent = report.report;
  reportUsageEl.textContent = report.usage?.total_tokens
    ? `${report.usage.total_tokens.toLocaleString()} tokens`
    : "Tokens not reported";
}

function tokenTotal(record) {
  return Math.max(0, Math.floor(record?.usage?.total_tokens || 0));
}

function renderInsights() {
  const reportItems = allReports();
  const summaries = Object.values(pageSummaries).flat();
  const doneSummaries = summaries.filter((item) => item.status === "done");
  const errors = summaries.filter((item) => item.status === "error");
  const tokenCount = [...reportItems, ...summaries].reduce((sum, item) => sum + tokenTotal(item), 0);
  const typeCounts = new Map();
  const topicCounts = new Map();

  for (const summary of doneSummaries) {
    const type = summary.structuredSummary?.contentType || "other";
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);

    for (const topic of summary.structuredSummary?.topics || []) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  }

  reportCountEl.textContent = String(reportItems.length);
  summaryCountEl.textContent = String(doneSummaries.length);
  tokenCountEl.textContent = tokenCount.toLocaleString();
  errorCountEl.textContent = String(errors.length);

  contentTypesEl.textContent = "";
  const typeEntries = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (!typeEntries.length) {
    const empty = document.createElement("p");
    empty.className = "emptyText";
    empty.textContent = "No summarized content yet.";
    contentTypesEl.append(empty);
  }
  for (const [type, count] of typeEntries) {
    const pill = document.createElement("span");
    pill.textContent = `${type} ${count}`;
    contentTypesEl.append(pill);
  }

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

    button.className = "reportItem";
    title.textContent = `${report.period}: ${report.startDate} - ${report.endDate}`;
    meta.textContent = new Date(report.createdAt).toLocaleString();
    button.append(title, meta);
    button.addEventListener("click", () => renderReport(report));
    reportListEl.append(button);
  }

  renderReport(items[0]);
}

async function loadReports() {
  const data = await sendMessage({ type: "GET_ANALYSIS_DATA" });
  reports = data.analysisReports || {};
  pageSummaries = data.pageSummaries || {};
  renderList();
}

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", async () => {
    const period = button.dataset.period;
    reportBodyEl.textContent = `Generating ${period} analysis...`;
    try {
      const report = await sendMessage({
        type: "RUN_ANALYSIS",
        period,
        endDateKey: endDateEl.value
      });
      reports[period] = reports[period] || [];
      reports[period].unshift(report);
      renderList();
      renderReport(report);
    } catch (error) {
      reportBodyEl.textContent = error.message || "Analysis failed.";
    }
  });
});

endDateEl.value = TimeUtils.dateKeyFromTimestamp(Date.now());
loadReports();
