// ─────────────────────────────────────────────────────────────
// LocalPanel — navigates a local directory via File System
// Access API (Chrome 86+, Firefox 111+).
// ─────────────────────────────────────────────────────────────
class LocalPanel {
  constructor(ui) {
    this.ui = ui;
    this.rootHandle = null;
    this.currentHandle = null;
    this.breadcrumb = [];
    this.files = [];
    this.supported = typeof window.showDirectoryPicker === "function";
    this.selectedEntry = null;
    this._selectedEl = null;
  }

  get currentPath() {
    if (!this.rootHandle) return "";
    return "/" + this.breadcrumb.map((e) => e.name).join("/");
  }

  async open() {
    if (!this.supported) {
      this.ui.showError(
        "File System Access API not supported in this browser.",
      );
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      this.rootHandle = handle;
      this.currentHandle = handle;
      this.breadcrumb = [];
      await this.refresh();
    } catch (err) {
      if (err.name !== "AbortError") {
        this.ui.showError("Could not open folder: " + err.message);
      }
    }
  }

  async navigate(handle, name) {
    this.breadcrumb.push({ name, handle: this.currentHandle });
    this.currentHandle = handle;
    await this.refresh();
  }

  async goUp() {
    if (this.breadcrumb.length === 0) return;
    this.selectedEntry = null;
    this._selectedEl = null;
    const parent = this.breadcrumb.pop();
    this.currentHandle = parent.handle;
    await this.refresh();
  }

  async refresh() {
    if (!this.currentHandle) return;
    this.ui.setLoading("local", true);
    try {
      const entries = [];
      for await (const [name, handle] of this.currentHandle.entries()) {
        let size = 0;
        let modTime = null;
        if (handle.kind === "file") {
          try {
            const file = await handle.getFile();
            size = file.size;
            modTime = new Date(file.lastModified);
          } catch (_) {}
        }
        entries.push({
          name,
          isDir: handle.kind === "directory",
          size,
          modTime,
          handle,
        });
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      this.files = entries;
      this.render();
    } catch (err) {
      this.ui.showError("Error reading local folder: " + err.message);
    } finally {
      this.ui.setLoading("local", false);
    }
  }

  render() {
    const el = document.getElementById("local-path");
    el.textContent = this.currentPath || "(no folder opened)";

    const upBtn = document.getElementById("local-up-btn");
    upBtn.disabled = this.breadcrumb.length === 0;

    const list = document.getElementById("local-file-list");
    list.innerHTML = "";

    if (!this.currentHandle) {
      const msg = document.createElement("div");
      msg.className = "empty-directory";
      msg.textContent = "Click 'Open Folder' to browse local files.";
      list.appendChild(msg);
      return;
    }

    if (this.files.length === 0) {
      const msg = document.createElement("div");
      msg.className = "empty-directory";
      msg.textContent = "This directory is empty.";
      list.appendChild(msg);
      return;
    }

    for (const entry of this.files) {
      list.appendChild(this._createItem(entry));
    }
  }

  _select(entry, el) {
    if (this._selectedEl) this._selectedEl.classList.remove("selected");
    if (this.selectedEntry === entry) {
      this.selectedEntry = null;
      this._selectedEl = null;
    } else {
      this.selectedEntry = entry;
      this._selectedEl = el;
      el.classList.add("selected");
    }
  }

  _createItem(entry) {
    const item = document.createElement("div");
    item.className = `file-item ${entry.isDir ? "folder" : "file"}`;

    const nameCol = document.createElement("div");
    nameCol.className = "file-name";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = entry.isDir ? "📁" : "📄";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = entry.name;
    nameCol.appendChild(icon);
    nameCol.appendChild(nameSpan);

    const sizeCol = document.createElement("div");
    sizeCol.className = "file-size";
    sizeCol.textContent = entry.isDir ? "-" : formatSize(entry.size);

    const dateCol = document.createElement("div");
    dateCol.className = "file-date";
    dateCol.textContent = entry.modTime ? formatDate(entry.modTime) : "-";

    const actionsCol = document.createElement("div");
    actionsCol.className = "file-actions";

    item.appendChild(nameCol);
    item.appendChild(sizeCol);
    item.appendChild(dateCol);
    item.appendChild(actionsCol);

    item.addEventListener("click", () => this._select(entry, item));

    if (entry.isDir) {
      item.addEventListener("dblclick", () => {
        this.selectedEntry = null;
        this._selectedEl = null;
        this.navigate(entry.handle, entry.name);
      });
    }

    return item;
  }
}

// ─────────────────────────────────────────────────────────────
// RemotePanel — navigates the server via /api/* endpoints.
// All existing upload / rename / delete / move logic lives here.
// ─────────────────────────────────────────────────────────────
class RemotePanel {
  constructor(ui) {
    this.ui = ui;
    this.currentPath = "/";
    this.files = []; // [{name, isDir, size, sizeFormatted, modTime, path}]

    this.uploadQueue = [];
    this.isUploading = false;
    this.conflictedFiles = [];
    this.fileUploadCounter = {
      success: 0,
      error: 0,
      overwritten: 0,
      ignored: 0,
    };
    this.uploadBehavior = { skipall: false, overwriteall: false };

    // Pending action state
    this.pendingDelete = null; // {path, name}
    this.pendingRename = null; // {path}
    this.pendingMove = null; // {path, name}

    this.selectedEntry = null;
    this._selectedEl = null;
  }

  parentOf(path) {
    return path.split("/").slice(0, -1).join("/") || "/";
  }

  async load(path) {
    this.selectedEntry = null;
    this._selectedEl = null;
    this.ui.setLoading("remote", true);
    try {
      const res = await fetch(`/api/list?path=${encodeURIComponent(path)}`);
      if (!res.ok)
        throw new Error(`Server error ${res.status}: ${await res.text()}`);
      const data = await res.json();
      this.currentPath = data.currentPath;
      this.files = data.files || [];
      this.render();
      updateURL(data.currentPath);
    } catch (err) {
      this.ui.showError("Failed to load directory: " + err.message);
    } finally {
      this.ui.setLoading("remote", false);
    }
  }

  async refresh() {
    await this.load(this.currentPath);
  }

  goUp() {
    if (this.currentPath !== "/") {
      this.load(this.parentOf(this.currentPath));
    }
  }

  render() {
    const pathEl = document.getElementById("remote-path");
    pathEl.textContent = this.currentPath;

    const upBtn = document.getElementById("remote-up-btn");
    upBtn.disabled = this.currentPath === "/";

    const list = document.getElementById("remote-file-list");
    list.innerHTML = "";

    if (this.files.length === 0) {
      const msg = document.createElement("div");
      msg.className = "empty-directory";
      msg.textContent = "This directory is empty.";
      list.appendChild(msg);
      return;
    }

    for (const file of this.files) {
      list.appendChild(this._createItem(file));
    }
  }

  _select(file, el) {
    if (this._selectedEl) this._selectedEl.classList.remove("selected");
    if (this.selectedEntry === file) {
      this.selectedEntry = null;
      this._selectedEl = null;
    } else {
      this.selectedEntry = file;
      this._selectedEl = el;
      el.classList.add("selected");
    }
  }

  _createItem(file) {
    const item = document.createElement("div");
    item.className = `file-item ${file.isDir ? "folder" : "file"}`;

    const nameCol = document.createElement("div");
    nameCol.className = "file-name";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = file.isDir ? "📁" : "📄";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = file.name;
    nameCol.appendChild(icon);
    nameCol.appendChild(nameSpan);

    const sizeCol = document.createElement("div");
    sizeCol.className = "file-size";
    sizeCol.textContent = file.isDir
      ? "-"
      : file.sizeFormatted || formatSize(file.size);

    const dateCol = document.createElement("div");
    dateCol.className = "file-date";
    dateCol.textContent = file.modTime
      ? formatDate(new Date(file.modTime))
      : "-";

    const actionsCol = document.createElement("div");
    actionsCol.className = "file-actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "btn btn-secondary btn-small";
    renameBtn.title = "Rename";
    renameBtn.textContent = "✏️";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._startRename(file.path, file.name);
    });

    const moveBtn = document.createElement("button");
    moveBtn.className = "btn btn-primary btn-small";
    moveBtn.title = "Move";
    moveBtn.textContent = "➡️";
    moveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._startMove(file.path, file.name);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-danger btn-small";
    deleteBtn.title = "Delete";
    deleteBtn.textContent = "🗑️";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._startDelete(file.path, file.name);
    });

    actionsCol.appendChild(renameBtn);
    actionsCol.appendChild(moveBtn);
    actionsCol.appendChild(deleteBtn);

    item.appendChild(nameCol);
    item.appendChild(sizeCol);
    item.appendChild(dateCol);
    item.appendChild(actionsCol);

    item.addEventListener("click", (e) => {
      if (!e.target.closest(".btn")) this._select(file, item);
    });

    if (file.isDir) {
      item.addEventListener("dblclick", (e) => {
        if (!e.target.closest(".btn")) this.load(file.path);
      });
    }

    return item;
  }

  // ── Delete ────────────────────────────────────────────────
  _startDelete(path, name) {
    this.pendingDelete = { path, name };
    const msg = document.getElementById("delete-message");
    msg.textContent = `Are you sure you want to delete "${name}"? This cannot be undone.`;
    showModal("delete-modal");
  }

  async confirmDelete() {
    const { path, name } = this.pendingDelete;
    this.pendingDelete = null;
    hideModal("delete-modal");
    this.ui.showLoadingOverlay(true, `Deleting "${name}"...`);
    try {
      const res = await fetch("/api/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Delete failed");
      this.ui.showSuccess(`"${name}" deleted`);
      await this.refresh();
    } catch (err) {
      this.ui.showError("Delete failed: " + err.message);
    } finally {
      this.ui.showLoadingOverlay(false);
    }
  }

  // ── Rename ────────────────────────────────────────────────
  _startRename(path, currentName) {
    this.pendingRename = { path };
    const input = document.getElementById("rename-input");
    input.value = currentName;
    showModal("rename-modal");
    input.focus();
    input.select();
  }

  async confirmRename() {
    const newName = document.getElementById("rename-input").value.trim();
    if (!newName) {
      this.ui.showWarning("Enter a valid name");
      return;
    }
    hideModal("rename-modal");
    this.ui.showLoadingOverlay(true, "Renaming...");
    try {
      const res = await fetch("/api/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPath: this.pendingRename.path, newName }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Rename failed");
      this.ui.showSuccess("Renamed successfully");
      await this.refresh();
    } catch (err) {
      this.ui.showError("Rename failed: " + err.message);
    } finally {
      this.pendingRename = null;
      this.ui.showLoadingOverlay(false);
    }
  }

  // ── New Folder ────────────────────────────────────────────
  showNewFolderModal() {
    document.getElementById("new-folder-input").value = "";
    showModal("new-folder-modal");
    document.getElementById("new-folder-input").focus();
  }

  async confirmNewFolder() {
    const name = document.getElementById("new-folder-input").value.trim();
    if (!name) return;
    hideModal("new-folder-modal");
    try {
      const res = await fetch("/api/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: this.currentPath, name }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Mkdir failed");
      this.ui.showSuccess("Folder created");
      await this.refresh();
    } catch (err) {
      this.ui.showError("Create folder failed: " + err.message);
    }
  }

  // ── Move ──────────────────────────────────────────────────
  _startMove(path, name) {
    this.pendingMove = { path, name };
    showModal("move-modal");
    this._loadMoveDir("/");
  }

  async _loadMoveDir(path) {
    try {
      const res = await fetch(`/api/ls?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      const list = document.getElementById("move-file-list");
      list.innerHTML = "";
      (data.files || []).forEach((f) => {
        if (!f.isDir) return;
        const item = document.createElement("div");
        item.className = "file-item folder";
        const icon = document.createElement("span");
        icon.className = "file-icon";
        icon.textContent = "📁";
        const label = document.createElement("span");
        label.textContent = f.name;
        item.appendChild(icon);
        item.appendChild(label);
        item.addEventListener("click", () => this._loadMoveDir(f.path));
        list.appendChild(item);
      });
      document.getElementById("move-current-path").textContent =
        data.currentPath;
      document.getElementById("move-go-up-btn").disabled =
        data.currentPath === "/";
    } catch (err) {
      this.ui.showError("Failed to load move directory: " + err.message);
    }
  }

  async confirmMove() {
    const to = document.getElementById("move-current-path").textContent;
    const { path, name } = this.pendingMove;
    this.pendingMove = null;
    hideModal("move-modal");
    this.ui.showLoadingOverlay(true, `Moving "${name}"...`);
    try {
      const res = await fetch("/api/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: path, to }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Move failed");
      this.ui.showSuccess("Moved successfully");
      await this.refresh();
    } catch (err) {
      this.ui.showError("Move failed: " + err.message);
    } finally {
      this.ui.showLoadingOverlay(false);
    }
  }

  // ── Upload ────────────────────────────────────────────────
  async _processUploadQueue() {
    if (this.isUploading || this.uploadQueue.length === 0) return;
    this.isUploading = true;
    const total = this.uploadQueue.length;
    let done = 0;
    this.ui.showUploadProgress(true);

    while (this.uploadQueue.length > 0) {
      const { file, path, createPath } = this.uploadQueue.shift();
      try {
        const uploaded = await this._uploadFile(file, path, false, createPath);
        if (uploaded) this.fileUploadCounter.success++;
      } catch (err) {
        this.fileUploadCounter.error++;
        console.error("Upload failed:", err);
      }
      done++;
      this.ui.updateUploadProgress(done, total);
    }

    while (this.conflictedFiles.length > 0) {
      const { file, path, createPath, filename } = this.conflictedFiles.shift();
      await new Promise((resolve) => {
        this.currentConflictResolve = resolve;
        this.currentConflictFile = file;
        this.currentConflictPath = path;
        this.currentConflictCreatePath = createPath;
        if (this.uploadBehavior.overwriteall) {
          this._resolveConflict(true);
        } else if (this.uploadBehavior.skipall) {
          this._resolveConflict(false);
        } else {
          this._showConflictModal(filename);
        }
      });
    }

    this.isUploading = false;
    this.ui.showUploadProgress(false);

    if (this.fileUploadCounter.success > 0) {
      this.ui.showSuccess(
        `Uploaded ${this.fileUploadCounter.success} file(s)` +
          (this.fileUploadCounter.ignored > 0
            ? `, ${this.fileUploadCounter.ignored} skipped`
            : ""),
      );
    }
    if (
      this.fileUploadCounter.error > 0 &&
      this.fileUploadCounter.success === 0
    ) {
      this.ui.showError(
        `Failed to upload ${this.fileUploadCounter.error} file(s)`,
      );
    }

    this.fileUploadCounter = {
      success: 0,
      error: 0,
      overwritten: 0,
      ignored: 0,
    };
    this.uploadBehavior = { skipall: false, overwriteall: false };
    await this.refresh();
  }

  async _uploadFile(file, path, overwrite = false, createPath = false) {
    const form = new FormData();
    form.append("path", path);
    if (overwrite) form.append("overwrite", "true");
    if (createPath) form.append("createPath", "true");
    form.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const result = await res.json();
    if (result.conflict) {
      this.conflictedFiles.push({
        file,
        path,
        createPath,
        filename: result.filename,
      });
      return false;
    }
    if (!result.success) throw new Error(result.error || "Upload failed");
    return true;
  }

  _showConflictModal(filename) {
    const msg = document.getElementById("conflict-message");
    msg.textContent = `"${filename}" already exists. What would you like to do?`;
    showModal("conflict-modal");
  }

  async _resolveConflict(overwrite) {
    const repeat = document.getElementById("repeat-conflict-action").checked;
    if (overwrite) {
      this.uploadBehavior.overwriteall = repeat;
    } else {
      this.uploadBehavior.skipall = repeat;
    }
    hideModal("conflict-modal");
    try {
      if (overwrite) {
        await this._uploadFile(
          this.currentConflictFile,
          this.currentConflictPath,
          true,
          this.currentConflictCreatePath,
        );
        this.fileUploadCounter.overwritten++;
      } else {
        this.fileUploadCounter.ignored++;
      }
    } catch (err) {
      this.fileUploadCounter.error++;
      console.error("Upload failed:", err);
    } finally {
      if (this.currentConflictResolve) this.currentConflictResolve();
    }
  }
}

// ─────────────────────────────────────────────────────────────
// UI — shared notification / overlay helpers
// ─────────────────────────────────────────────────────────────
class UI {
  setLoading(panel, show) {
    const el = document.getElementById(`${panel}-loading`);
    if (el) el.style.display = show ? "block" : "none";
  }

  showLoadingOverlay(show, message = "Processing...") {
    const overlay = document.getElementById("loading-overlay");
    const msg = overlay.querySelector(".loading-spinner div:last-child");
    if (show) {
      msg.textContent = message;
      overlay.classList.add("show");
    } else {
      overlay.classList.remove("show");
    }
  }

  showUploadProgress(show) {
    document.getElementById("upload-progress").style.display = show
      ? "block"
      : "none";
    if (show) {
      document.getElementById("progress-text").textContent = "Uploading...";
      document.getElementById("progress-fill").style.width = "0%";
    }
  }

  updateUploadProgress(current, total) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    document.getElementById("progress-fill").style.width = `${pct}%`;
    document.getElementById("progress-text").textContent =
      `Uploading ${current} of ${total}...`;
  }

  showError(msg) {
    this._notify("Error", msg, "error");
  }
  showSuccess(msg) {
    this._notify("Success", msg, "success");
  }
  showWarning(msg) {
    this._notify("Warning", msg, "warning");
  }
  showInfo(msg) {
    this._notify("Info", msg, "info");
  }

  _notify(title, message, type = "info") {
    const icons = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };
    const container = document.getElementById("notification-container");
    const n = document.createElement("div");
    n.className = `notification ${type}`;

    const iconEl = document.createElement("span");
    iconEl.className = "notification-icon";
    iconEl.textContent = icons[type];

    const content = document.createElement("div");
    content.className = "notification-content";
    const titleEl = document.createElement("div");
    titleEl.className = "notification-title";
    titleEl.textContent = title;
    const msgEl = document.createElement("div");
    msgEl.className = "notification-message";
    msgEl.textContent = message;
    content.appendChild(titleEl);
    content.appendChild(msgEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "notification-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => n.remove());

    n.appendChild(iconEl);
    n.appendChild(content);
    n.appendChild(closeBtn);
    container.appendChild(n);
    setTimeout(() => {
      if (n.parentElement) n.remove();
    }, 5000);
  }
}

// ─────────────────────────────────────────────────────────────
// FileManager — orchestrates both panels + cross-panel actions
// ─────────────────────────────────────────────────────────────
class FileManager {
  constructor() {
    this.ui = new UI();
    this.local = new LocalPanel(this.ui);
    this.remote = new RemotePanel(this.ui);
    this._setupListeners();
    this.remote.load(getPathFromURL());
    this.local.render(); // render empty state
  }

  _setupListeners() {
    // ── Local panel ──
    document
      .getElementById("local-open-btn")
      .addEventListener("click", () => this.local.open());
    document
      .getElementById("local-up-btn")
      .addEventListener("click", () => this.local.goUp());
    document
      .getElementById("local-refresh-btn")
      .addEventListener("click", () => this.local.refresh());

    // ── Remote panel ──
    document
      .getElementById("remote-up-btn")
      .addEventListener("click", () => this.remote.goUp());
    document
      .getElementById("remote-refresh-btn")
      .addEventListener("click", () => this.remote.refresh());
    document
      .getElementById("remote-new-folder-btn")
      .addEventListener("click", () => this.remote.showNewFolderModal());

    // ── Transfer ──
    document
      .getElementById("transfer-up-btn")
      .addEventListener("click", () => this._uploadLocalToRemote());
    document
      .getElementById("transfer-down-btn")
      .addEventListener("click", () => this._downloadRemoteToLocal());

    // ── Compare ──
    document
      .getElementById("compare-btn")
      .addEventListener("click", () => this._compare());
    document
      .getElementById("compare-close")
      .addEventListener("click", () => hideModal("compare-modal"));

    // ── Rename modal ──
    document
      .getElementById("rename-confirm")
      .addEventListener("click", () => this.remote.confirmRename());
    document
      .getElementById("rename-cancel")
      .addEventListener("click", () => hideModal("rename-modal"));
    document.getElementById("rename-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.remote.confirmRename();
      if (e.key === "Escape") hideModal("rename-modal");
    });

    // ── New folder modal ──
    document
      .getElementById("new-folder-confirm")
      .addEventListener("click", () => this.remote.confirmNewFolder());
    document
      .getElementById("new-folder-cancel")
      .addEventListener("click", () => hideModal("new-folder-modal"));
    document
      .getElementById("new-folder-input")
      .addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.remote.confirmNewFolder();
        if (e.key === "Escape") hideModal("new-folder-modal");
      });

    // ── Delete modal ──
    document
      .getElementById("delete-confirm")
      .addEventListener("click", () => this.remote.confirmDelete());
    document
      .getElementById("delete-cancel")
      .addEventListener("click", () => hideModal("delete-modal"));

    // ── Move modal ──
    document
      .getElementById("move-confirm")
      .addEventListener("click", () => this.remote.confirmMove());
    document
      .getElementById("move-cancel")
      .addEventListener("click", () => hideModal("move-modal"));
    document.getElementById("move-go-up-btn").addEventListener("click", () => {
      const cur = document.getElementById("move-current-path").textContent;
      if (cur && cur !== "/") this.remote._loadMoveDir(parentOf(cur));
    });

    // ── Conflict modal ──
    document
      .getElementById("conflict-overwrite")
      .addEventListener("click", () => this.remote._resolveConflict(true));
    document
      .getElementById("conflict-skip")
      .addEventListener("click", () => this.remote._resolveConflict(false));

    // ── Close modals on backdrop click ──
    document.querySelectorAll(".modal").forEach((modal) => {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) hideModal(modal.id);
      });
    });

    // ── Browser back/forward ──
    window.addEventListener("popstate", (e) => {
      this.remote.load(e.state?.path || getPathFromURL());
    });
  }

  // Recursively walk a FileSystemDirectoryHandle and collect every file as
  // {file: File, path: string, createPath: bool} ready for _processUploadQueue.
  async _collectLocalFiles(dirHandle, remotePath) {
    const uploads = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === "file") {
        try {
          const file = await handle.getFile();
          uploads.push({ file, path: remotePath, createPath: true });
        } catch (err) {
          this.ui.showError(`Cannot read "${name}": ${err.message}`);
        }
      } else if (handle.kind === "directory") {
        const subPath =
          remotePath === "/" ? "/" + name : remotePath + "/" + name;
        const sub = await this._collectLocalFiles(handle, subPath);
        uploads.push(...sub);
      }
    }
    return uploads;
  }

  // Recursively collect all remote files under a given path as
  // {remotePath, name, localDirHandle} entries.
  async _collectRemoteFiles(remotePath, localDirHandle) {
    const res = await fetch(`/api/list?path=${encodeURIComponent(remotePath)}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    const entries = [];
    for (const f of data.files || []) {
      if (!f.isDir) {
        entries.push({ remotePath: f.path, name: f.name, localDirHandle });
      } else {
        const subDirHandle = await localDirHandle.getDirectoryHandle(f.name, {
          create: true,
        });
        const sub = await this._collectRemoteFiles(f.path, subDirHandle);
        entries.push(...sub);
      }
    }
    return entries;
  }

  async _uploadLocalToRemote() {
    if (!this.local.currentHandle) {
      this.ui.showWarning("Open a local folder first.");
      return;
    }
    if (this.remote.isUploading) {
      this.ui.showWarning("An upload is already in progress.");
      return;
    }

    this.ui.showUploadProgress(true);
    document.getElementById("progress-text").textContent =
      "Collecting files...";

    const sel = this.local.selectedEntry;
    let uploads;
    try {
      if (sel && !sel.isDir) {
        const file = await sel.handle.getFile();
        uploads = [{ file, path: this.remote.currentPath, createPath: true }];
      } else if (sel && sel.isDir) {
        const subPath =
          this.remote.currentPath === "/"
            ? "/" + sel.name
            : this.remote.currentPath + "/" + sel.name;
        uploads = await this._collectLocalFiles(sel.handle, subPath);
      } else {
        uploads = await this._collectLocalFiles(
          this.local.currentHandle,
          this.remote.currentPath,
        );
      }
    } catch (err) {
      this.ui.showError("Failed to collect local files: " + err.message);
      this.ui.showUploadProgress(false);
      return;
    }

    if (uploads.length === 0) {
      this.ui.showWarning("No files found to upload.");
      this.ui.showUploadProgress(false);
      return;
    }

    this.ui.showUploadProgress(false);
    this.remote.uploadQueue = uploads;
    this.remote._processUploadQueue();
  }

  async _downloadRemoteToLocal() {
    if (!this.local.supported) {
      this.ui.showError(
        "File System Access API not supported in this browser.",
      );
      return;
    }

    let destHandle;
    // If a local folder is already open, target it directly after upgrading to
    // readwrite permission; otherwise open the picker starting at that folder.
    if (this.local.currentHandle) {
      const perm = await this.local.currentHandle.requestPermission({
        mode: "readwrite",
      });
      if (perm === "granted") {
        destHandle = this.local.currentHandle;
      }
    }
    if (!destHandle) {
      try {
        destHandle = await window.showDirectoryPicker({
          mode: "readwrite",
          startIn: this.local.currentHandle || "documents",
        });
      } catch (err) {
        if (err.name !== "AbortError")
          this.ui.showError("Could not open destination: " + err.message);
        return;
      }
    }

    this.ui.showUploadProgress(true);
    document.getElementById("progress-text").textContent =
      "Collecting files...";

    const sel = this.remote.selectedEntry;
    let entries;
    try {
      if (sel && !sel.isDir) {
        entries = [
          { remotePath: sel.path, name: sel.name, localDirHandle: destHandle },
        ];
      } else if (sel && sel.isDir) {
        const subDirHandle = await destHandle.getDirectoryHandle(sel.name, {
          create: true,
        });
        entries = await this._collectRemoteFiles(sel.path, subDirHandle);
      } else {
        entries = await this._collectRemoteFiles(
          this.remote.currentPath,
          destHandle,
        );
      }
    } catch (err) {
      this.ui.showError("Failed to collect remote files: " + err.message);
      this.ui.showUploadProgress(false);
      return;
    }

    if (entries.length === 0) {
      this.ui.showWarning("No files found to download.");
      this.ui.showUploadProgress(false);
      return;
    }

    const total = entries.length;
    let done = 0;
    let errors = 0;

    for (const { remotePath, name, localDirHandle } of entries) {
      try {
        const res = await fetch(
          `/api/download?path=${encodeURIComponent(remotePath)}`,
        );
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const blob = await res.blob();
        const fileHandle = await localDirHandle.getFileHandle(name, {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (err) {
        errors++;
        this.ui.showError(`Failed to download "${name}": ${err.message}`);
      }
      done++;
      this.ui.updateUploadProgress(done, total);
    }

    this.ui.showUploadProgress(false);
    if (errors < total) {
      this.ui.showSuccess(`Downloaded ${total - errors} of ${total} file(s).`);
    }
    await this.local.refresh();
  }

  _compare() {
    if (!this.local.currentHandle) {
      this.ui.showWarning("Open a local folder first.");
      return;
    }

    const localFiles = this.local.files;
    const remoteFiles = this.remote.files;

    const localMap = new Map(localFiles.map((f) => [f.name, f]));
    const remoteMap = new Map(remoteFiles.map((f) => [f.name, f]));

    const onlyLocal = [];
    const onlyRemote = [];
    const different = [];

    for (const [name, lf] of localMap) {
      if (!remoteMap.has(name)) {
        onlyLocal.push(name);
      } else {
        const rf = remoteMap.get(name);
        const sizeDiff = !lf.isDir && !rf.isDir && lf.size !== rf.size;
        const timeDiff =
          lf.modTime &&
          rf.modTime &&
          Math.abs(lf.modTime.getTime() - new Date(rf.modTime).getTime()) >
            2000;
        if (sizeDiff || timeDiff) {
          const lSize = lf.isDir ? "-" : formatSize(lf.size);
          const rSize = rf.isDir ? "-" : formatSize(rf.size);
          const lTime = lf.modTime ? formatDate(lf.modTime) : "-";
          const rTime = rf.modTime ? formatDate(new Date(rf.modTime)) : "-";
          different.push(
            `${name}  (local: ${lSize} / ${lTime}  —  remote: ${rSize} / ${rTime})`,
          );
        }
      }
    }

    for (const [name] of remoteMap) {
      if (!localMap.has(name)) onlyRemote.push(name);
    }

    document.getElementById("compare-local-path").textContent =
      this.local.currentPath;
    document.getElementById("compare-remote-path").textContent =
      this.remote.currentPath;

    _fillCompareList("compare-only-local", onlyLocal);
    _fillCompareList("compare-only-remote", onlyRemote);
    _fillCompareList("compare-different", different);

    showModal("compare-modal");
  }
}

// ─────────────────────────────────────────────────────────────
// Module-level helpers (no class needed)
// ─────────────────────────────────────────────────────────────
function showModal(id) {
  document.getElementById(id).classList.add("show");
}
function hideModal(id) {
  document.getElementById(id).classList.remove("show");
}

function parentOf(path) {
  return path.split("/").slice(0, -1).join("/") || "/";
}

function getPathFromURL() {
  return new URLSearchParams(window.location.search).get("path") || "/";
}

function updateURL(path) {
  const url = new URL(window.location);
  if (path === "/" || path === "") {
    url.searchParams.delete("path");
  } else {
    url.searchParams.set("path", path);
  }
  window.history.pushState({ path }, "", url);
  document.title = `File Manager — ${path === "/" ? "Root" : path}`;
}

function formatSize(size) {
  const unit = 1024;
  if (size < unit) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let div = unit,
    exp = 0;
  for (let n = size / unit; n >= unit; n /= unit) {
    div *= unit;
    exp++;
  }
  return `${(size / div).toFixed(1)} ${units[exp]}`;
}

function formatDate(date) {
  return (
    date.toLocaleDateString() +
    " " +
    date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

function _fillCompareList(id, items) {
  const ul = document.getElementById(id);
  ul.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "—";
    li.style.color = "var(--fg3)";
    li.style.fontStyle = "italic";
    ul.appendChild(li);
    return;
  }
  for (const text of items) {
    const li = document.createElement("li");
    li.textContent = text;
    ul.appendChild(li);
  }
}

// ── Bootstrap ──────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  new FileManager();
});
