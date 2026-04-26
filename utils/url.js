(function attachUrlUtils(global) {
  const TRACKED_PROTOCOLS = new Set(["http:", "https:"]);

  function normalizeDomain(hostname) {
    return hostname.replace(/^www\./i, "").toLowerCase();
  }

  function getPageIdentity(rawUrl) {
    if (!rawUrl) {
      return null;
    }

    try {
      const url = new URL(rawUrl);
      if (!TRACKED_PROTOCOLS.has(url.protocol) || !url.hostname) {
        return null;
      }

      return {
        domain: normalizeDomain(url.hostname),
        url: url.href
      };
    } catch {
      return null;
    }
  }

  global.UrlUtils = {
    getPageIdentity,
    normalizeDomain
  };
})(globalThis);
