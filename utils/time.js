(function attachTimeUtils(global) {
  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function dateKeyFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function systemTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "System";
  }

  function startOfNextDay(timestamp) {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  }

  function startOfWeek(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    const day = date.getDay() || 7;
    date.setDate(date.getDate() - day + 1);
    return date.getTime();
  }

  function weekKeyFromTimestamp(timestamp) {
    const start = startOfWeek(timestamp);
    const date = new Date(start);
    const thursday = new Date(start);
    thursday.setDate(thursday.getDate() + 3);
    const weekYear = thursday.getFullYear();
    const yearStart = startOfWeek(new Date(weekYear, 0, 4).getTime());
    const week = Math.floor((start - yearStart) / (7 * 24 * 60 * 60 * 1000)) + 1;
    return `${weekYear}-W${pad(week)}`;
  }

  function weekRangeFromTimestamp(timestamp) {
    const start = startOfWeek(timestamp);
    const end = start + 6 * 24 * 60 * 60 * 1000;
    return {
      key: weekKeyFromTimestamp(timestamp),
      startDate: dateKeyFromTimestamp(start),
      endDate: dateKeyFromTimestamp(end),
      startTs: start,
      endTs: start + 7 * 24 * 60 * 60 * 1000
    };
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
      return `${minutes}m ${rest}s`;
    }

    return `${rest}s`;
  }

  function formatClockSeconds(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return `${pad(hours)}:${pad(minutes)}:${pad(rest)}`;
  }

  global.TimeUtils = {
    dateKeyFromTimestamp,
    formatClockSeconds,
    formatDuration,
    startOfNextDay,
    startOfWeek,
    systemTimeZone,
    weekKeyFromTimestamp,
    weekRangeFromTimestamp
  };
})(globalThis);
