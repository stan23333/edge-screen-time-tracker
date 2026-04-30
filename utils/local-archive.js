(function attachLocalArchivePermission(global) {
  const LOCAL_ARCHIVE_DB = "web-screen-time-tracker-local-archive";
  const LOCAL_ARCHIVE_STORE = "handles";
  const LOCAL_ARCHIVE_HANDLE_KEY = "directory";

  function openLocalArchiveDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(LOCAL_ARCHIVE_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LOCAL_ARCHIVE_STORE)) {
          request.result.createObjectStore(LOCAL_ARCHIVE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getDirectoryHandle() {
    const db = await openLocalArchiveDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(LOCAL_ARCHIVE_STORE, "readonly");
      const request = transaction.objectStore(LOCAL_ARCHIVE_STORE).get(LOCAL_ARCHIVE_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function getFileHandle(rootHandle, relativePath) {
    const parts = String(relativePath || "").split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) {
      throw new Error("Local archive file path is missing.");
    }

    let directory = rootHandle;
    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part);
    }
    return directory.getFileHandle(fileName);
  }

  async function setDirectoryHandle(handle) {
    const db = await openLocalArchiveDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(LOCAL_ARCHIVE_STORE, "readwrite");
      transaction.objectStore(LOCAL_ARCHIVE_STORE).put(handle, LOCAL_ARCHIVE_HANDLE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function requestReadWritePermission(handle) {
    if (!handle) {
      return { ok: false, reason: "Choose a local archive folder in Settings before backup can write files." };
    }

    const current = await handle.queryPermission?.({ mode: "readwrite" });
    if (!current || current === "granted") {
      return { ok: true, handle };
    }

    const requested = await handle.requestPermission?.({ mode: "readwrite" });
    if (!requested || requested === "granted") {
      return { ok: true, handle };
    }

    return { ok: false, reason: "Local archive folder permission is not granted." };
  }

  async function ensurePermission() {
    const handle = await getDirectoryHandle();
    return requestReadWritePermission(handle);
  }

  async function permissionStatus() {
    const handle = await getDirectoryHandle();
    if (!handle) {
      return {
        ok: false,
        status: "not_selected",
        reason: "Choose a local archive folder in Settings before backup can write files."
      };
    }

    try {
      const current = await handle.queryPermission?.({ mode: "readwrite" });
      if (!current || current === "granted") {
        return {
          ok: true,
          status: "granted",
          name: handle.name || "Selected folder"
        };
      }
      return {
        ok: false,
        status: "needs_reauthorize",
        name: handle.name || "Selected folder",
        reason: "Local archive folder permission needs reauthorization."
      };
    } catch (error) {
      return {
        ok: false,
        status: "write_failed",
        name: handle.name || "Selected folder",
        reason: error.message || "Local archive folder permission could not be checked."
      };
    }
  }

  async function reauthorize() {
    return ensurePermission();
  }

  async function deleteFile(relativePath) {
    const permission = await ensurePermission();
    if (!permission.ok) {
      return { status: "error", error: permission.reason, relativePath };
    }

    const parts = String(relativePath || "").split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) {
      return { status: "skipped", reason: "Local archive file path is missing.", relativePath };
    }

    try {
      let directory = permission.handle;
      for (const part of parts) {
        directory = await directory.getDirectoryHandle(part);
      }
      await directory.removeEntry(fileName);
      return { status: "deleted", deletedAt: Date.now(), relativePath };
    } catch (error) {
      if (error?.name === "NotFoundError") {
        return { status: "deleted", deletedAt: Date.now(), relativePath, note: "File was already missing." };
      }
      return { status: "error", error: error.message || "Local archive delete failed.", relativePath };
    }
  }

  async function openFile(relativePath, targetWindow = null) {
    const permission = await ensurePermission();
    if (!permission.ok) {
      throw new Error(permission.reason);
    }

    const fileHandle = await getFileHandle(permission.handle, relativePath);
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    let opened = null;
    if (targetWindow && !targetWindow.closed) {
      targetWindow.location.href = url;
      opened = targetWindow;
    } else {
      opened = global.open(url, "_blank", "noopener");
    }
    global.setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    if (!opened) {
      throw new Error("The browser blocked the local file preview window.");
    }
    return { ok: true };
  }

  function isMissingFileError(error) {
    return error?.name === "NotFoundError"
      || /could not be found|not found|file or directory/i.test(error?.message || "");
  }

  async function grantDirectoryHandle(handle) {
    const permission = await requestReadWritePermission(handle);
    if (!permission.ok) {
      throw new Error(permission.reason);
    }
    await setDirectoryHandle(handle);
    return { ok: true, handle };
  }

  global.LocalArchivePermission = {
    deleteFile,
    ensurePermission,
    getDirectoryHandle,
    grantDirectoryHandle,
    isMissingFileError,
    openFile,
    permissionStatus,
    reauthorize,
    setDirectoryHandle
  };
})(globalThis);
