class FileManager {
    constructor() {
        this.currentPath = "/";
        this.uploadQueue = [];
        this.isUploading = false;
        this.conflictedFiles = [];
        this.fileUploadCounter = {
            success: 0,
            error: 0,
            overwritten: 0,
            ignored: 0,
        };
        this.uploadBehavior = {
            skipall: false,
            overwriteall: false,
        };
        this.init();
    }

    init() {
        this.setupEventListeners();

        // Get initial path from URL or default to root
        const urlPath = this.getPathFromURL();
        this.loadDirectory(urlPath);
    }

    getPathFromURL() {
        const urlParams = new URLSearchParams(window.location.search);
        const path = urlParams.get("path");
        return path || "/";
    }

    updateURL(path) {
        const url = new URL(window.location);
        if (path === "/" || path === "") {
            url.searchParams.delete("path");
        } else {
            url.searchParams.set("path", path);
        }

        // Update URL without triggering page reload
        window.history.pushState({ path }, "", url);

        // Update page title to show current path
        document.title = `File Manager - ${path === "/" ? "Root" : path}`;
    }

    setupEventListeners() {
        // Navigation
        document.getElementById("go-up-btn").addEventListener("click", () => {
            this.goUp();
        });

        // New folder
        document
            .getElementById("new-folder-btn")
            .addEventListener("click", () => {
                this.showNewFolderModal();
            });

        // Upload buttons
        document
            .getElementById("upload-files-btn")
            .addEventListener("click", () => {
                document.getElementById("file-input").click();
            });

        document
            .getElementById("upload-folder-btn")
            .addEventListener("click", () => {
                document.getElementById("folder-input").click();
            });

        // File input handlers
        document
            .getElementById("file-input")
            .addEventListener("change", (e) => {
                this.handleFileInput(e.target.files);
            });

        document
            .getElementById("folder-input")
            .addEventListener("change", (e) => {
                this.handleFileInput(e.target.files, true);
            });

        // Modal event listeners
        this.setupModalListeners();
    }

    setupModalListeners() {
        // Rename modal
        document
            .getElementById("rename-cancel")
            .addEventListener("click", () => {
                this.hideModal("rename-modal");
            });

        document
            .getElementById("rename-confirm")
            .addEventListener("click", () => {
                this.confirmRename();
            });

        document
            .getElementById("rename-input")
            .addEventListener("keypress", (e) => {
                if (e.key === "Enter") {
                    this.confirmRename();
                }
            });

        // New folder modal
        document
            .getElementById("new-folder-cancel")
            .addEventListener("click", () => {
                this.hideModal("new-folder-modal");
            });

        document
            .getElementById("new-folder-confirm")
            .addEventListener("click", () => {
                this.confirmNewFolder();
            });

        document
            .getElementById("new-folder-input")
            .addEventListener("keypress", (e) => {
                if (e.key === "Enter") {
                    this.confirmNewFolder();
                }
            });

        // Conflict modal
        document
            .getElementById("conflict-overwrite")
            .addEventListener("click", () => {
                this.resolveConflict(true);
            });

        document
            .getElementById("conflict-skip")
            .addEventListener("click", () => {
                this.resolveConflict(false);
            });

        // Delete modal
        document
            .getElementById("delete-confirm")
            .addEventListener("click", () => {
                this.confirmDelete();
            });

        document
            .getElementById("delete-cancel")
            .addEventListener("click", () => {
                this.hideModal("delete-modal");
            });

        // Close modals when clicking outside
        document.querySelectorAll(".modal").forEach((modal) => {
            modal.addEventListener("click", (e) => {
                if (e.target === modal) {
                    this.hideModal(modal.id);
                }
            });
        });

        // Handle browser back/forward buttons
        window.addEventListener("popstate", (e) => {
            const path = e.state?.path || this.getPathFromURL();
            this.loadDirectory(path);
        });
    }

    resetCounter() {
        this.fileUploadCounter = {
            success: 0,
            error: 0,
            overwritten: 0,
            ignored: 0,
        };
    }

    resetConflictBehavior() {
        this.uploadBehavior = {
            skipall: false,
            overwriteall: false,
        };
    }

    async loadDirectory(path) {
        this.showLoading(true);

        try {
            const response = await fetch(
                `/api/list?path=${encodeURIComponent(path)}`,
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(
                    `Server error (${response.status}): ${errorText}`,
                );
            }

            const data = await response.json();

            this.currentPath = data.currentPath;
            this.renderFileList(data);
            this.updatePathDisplay(data.currentPath, data.parentPath);

            // Update URL to reflect current path
            this.updateURL(data.currentPath);
        } catch (error) {
            console.error("Error loading directory:", error);
            this.showError(
                `Failed to load directory "${path}": ${error.message}`,
            );
        } finally {
            this.showLoading(false);
        }
    }

    renderFileList(data) {
        const fileList = document.getElementById("file-list");
        fileList.innerHTML = "";

        // Handle empty directories (files can be null or empty array)
        const files = data.files || [];

        if (files.length === 0) {
            const emptyMessage = document.createElement("div");
            emptyMessage.className = "empty-directory";
            emptyMessage.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #7f8c8d;">
                    📂 This directory is empty
                </div>
            `;
            fileList.appendChild(emptyMessage);
            return;
        }

        files.forEach((file) => {
            const fileItem = this.createFileItem(file);
            fileList.appendChild(fileItem);
        });
    }

    createFileItem(file) {
        const item = document.createElement("div");
        item.className = `file-item ${file.isDir ? "folder" : "file"}`;

        const icon = file.isDir ? "📁" : "📄";

        item.innerHTML = `
            <div class="file-name">
                <span class="file-icon">${icon}</span>
                <span>${this.escapeHtml(file.name)}</span>
            </div>
            <div class="file-size">${file.isDir ? "-" : file.sizeFormatted}</div>
            <div class="file-date">${this.formatDate(file.modTime)}</div>
            <div class="file-actions">
                <button class="btn btn-secondary btn-small rename-btn" data-path="${this.escapeHtml(file.path)}" data-name="${this.escapeHtml(file.name)}">✏️</button>
                <button class="btn btn-danger btn-small delete-btn" data-path="${this.escapeHtml(file.path)}" data-name="${this.escapeHtml(file.name)}">🗑️</button>
            </div>
        `;

        // Add event listeners for buttons
        const renameBtn = item.querySelector(".rename-btn");
        const deleteBtn = item.querySelector(".delete-btn");

        renameBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.renameItem(file.path, file.name);
        });

        deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.deleteItem(file.path, file.name);
        });

        if (file.isDir) {
            item.addEventListener("click", (e) => {
                if (!e.target.classList.contains("btn")) {
                    this.loadDirectory(file.path);
                }
            });
        }

        return item;
    }

    updatePathDisplay(currentPath, parentPath) {
        // Ensure currentPath is properly formatted
        const displayPath = currentPath || "/";
        document.getElementById("current-path-text").textContent = displayPath;

        const goUpBtn = document.getElementById("go-up-btn");
        // Enable up button if we have a parent path and we're not at root
        goUpBtn.disabled = !parentPath || displayPath === "/";
    }

    goUp() {
        if (this.currentPath && this.currentPath !== "/") {
            const parentPath =
                this.currentPath.split("/").slice(0, -1).join("/") || "/";
            this.loadDirectory(parentPath);
        }
    }

    async processFolderEntry(dirEntry, basePath, files) {
        return new Promise((resolve, reject) => {
            const dirReader = dirEntry.createReader();

            const readEntries = () => {
                dirReader.readEntries(async (entries) => {
                    if (entries.length === 0) {
                        resolve();
                        return;
                    }

                    for (const entry of entries) {
                        if (entry.isFile) {
                            const file = await this.getFileFromEntry(entry);
                            if (file) {
                                // Create the folder structure path
                                const relativePath =
                                    entry.fullPath.substring(1); // Remove leading slash
                                const folderPath =
                                    basePath +
                                    "/" +
                                    relativePath.substring(
                                        0,
                                        relativePath.lastIndexOf("/"),
                                    );
                                files.push({
                                    file,
                                    path: folderPath || basePath,
                                    createPath: true,
                                });
                            }
                        } else if (entry.isDirectory) {
                            await this.processFolderEntry(
                                entry,
                                basePath,
                                files,
                            );
                        }
                    }

                    // Read more entries
                    readEntries();
                }, reject);
            };

            readEntries();
        });
    }

    async getFileFromEntry(fileEntry) {
        return new Promise((resolve) => {
            fileEntry.file(resolve, () => resolve(null));
        });
    }

    async handleFileInput(files, isFolder = false) {
        if (files.length === 0) return;

        this.showInfo(`Processing ${isFolder ? "folder" : "file"} upload...`);

        const uploadFiles = [];

        for (const file of files) {
            if (isFolder && file.webkitRelativePath) {
                // Handle folder structure
                const pathParts = file.webkitRelativePath.split("/");
                if (pathParts.length > 1) {
                    // Remove filename from path to get folder structure
                    pathParts.pop();
                    const folderPath =
                        this.currentPath + "/" + pathParts.join("/");
                    uploadFiles.push({
                        file,
                        path: folderPath,
                        createPath: true,
                    });
                } else {
                    uploadFiles.push({ file, path: this.currentPath });
                }
            } else {
                // Regular file upload
                uploadFiles.push({ file, path: this.currentPath });
            }
        }

        if (uploadFiles.length === 0) {
            this.showWarning("No files found to upload");
            return;
        }

        this.showInfo(`Found ${uploadFiles.length} files to upload`);
        this.uploadQueue = uploadFiles;
        this.processUploadQueue();
    }

    async processUploadQueue() {
        if (this.isUploading || this.uploadQueue.length === 0) return;

        this.isUploading = true;
        this.showUploadProgress(true);

        while (this.uploadQueue.length > 0) {
            const { file, path, createPath } = this.uploadQueue.shift();
            try {
                await this.uploadFile(file, path, false, createPath);
                this.fileUploadCounter.success++;
            } catch (error) {
                this.fileUploadCounter.error++;
                console.error("Upload failed:", error);
            }
        }

        while (this.conflictedFiles.length > 0) {
            const { file, path, createPath, filename } =
                this.conflictedFiles.shift();

            const resolver = new Promise((resolve) => {
                this.currentConflictResolve = resolve;
                this.currentConflictFile = file;
                this.currentConflictPath = path;
                this.currentConflictCreatePath = createPath;

                if (this.uploadBehavior.overwriteall) {
                    this.resolveConflict(true);
                } else if (this.uploadBehavior.skipall) {
                    this.resolveConflict(false);
                } else {
                    // Show conflict modal and wait for resolution
                    this.showConflictModal(filename);
                }
            });

            await resolver;
        }

        this.isUploading = false;
        this.showUploadProgress(false);

        if (this.fileUploadCounter.success > 0) {
            this.showSuccess(
                `Successfully uploaded ${this.fileUploadCounter.success} file(s)${this.fileUploadCounter.ignored > 0 ? `, ${this.fileUploadCounter.ignored} ignored` : ""}`,
            );
        }
        if (
            this.fileUploadCounter.error > 0 &&
            this.fileUploadCounter.success === 0
        ) {
            this.showError(`Failed to upload ${failed} file(s)`);
        }

        this.resetCounter();
        this.resetConflictBehavior();

        this.loadDirectory(this.currentPath); // Refresh the file list
    }

    async uploadFile(file, path, overwrite = false, createPath = false) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("path", path);
        if (overwrite) {
            formData.append("overwrite", "true");
        }
        if (createPath) {
            formData.append("createPath", "true");
        }

        try {
            const response = await fetch("/api/upload", {
                method: "POST",
                body: formData,
            });

            const result = await response.json();

            if (result.conflict) {
                this.conflictedFiles.push({
                    file: file,
                    path: path,
                    createPath: createPath,
                    filename: result.filename,
                });
            } else if (!result.success) {
                throw new Error(result.error || "Upload failed");
            }
        } catch (error) {
            console.error("Upload error:", error);
            this.showError(`Failed to upload ${file.name}: ${error.message}`);
        }
    }

    showConflictModal(filename) {
        document.getElementById("conflict-message").textContent =
            `File "${filename}" already exists. What would you like to do?`;
        this.showModal("conflict-modal");
    }

    async resolveConflict(overwrite) {
        const repeatAction = document.getElementById(
            "repeat-conflict-action",
        ).checked;

        if (overwrite) {
            this.uploadBehavior.overwriteall = repeatAction;
        } else {
            this.uploadBehavior.skipall = repeatAction;
        }

        this.hideModal("conflict-modal");

        if (overwrite) {
            await this.uploadFile(
                this.currentConflictFile,
                this.currentConflictPath,
                true,
                this.currentConflictCreatePath,
            );

            this.fileUploadCounter.overwritten++;
        } else {
            this.fileUploadCounter.ignored++;
        }

        if (this.currentConflictResolve) {
            this.currentConflictResolve();
        }
    }

    async deleteItem(path, name) {
        // Store the delete details for the confirmation
        this.currentDeletePath = path;
        this.currentDeleteName = name;

        // Show the delete confirmation modal
        document.getElementById("delete-message").textContent =
            `Are you sure you want to delete "${name}"? This action cannot be undone.`;
        this.showModal("delete-modal");
    }

    async confirmDelete() {
        this.hideModal("delete-modal");

        const path = this.currentDeletePath;
        const name = this.currentDeleteName;

        this.showLoadingOverlay(true, `Deleting "${name}"...`);
        this.showInfo(`Starting deletion of "${name}"`);

        try {
            const response = await fetch("/api/delete", {
                method: "DELETE",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ path }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("Delete response error:", errorText);
                throw new Error(
                    `Server error (${response.status}): ${errorText}`,
                );
            }

            const result = await response.json();

            if (result.success) {
                this.showSuccess(`"${name}" deleted successfully`);
                // Wait a moment to show the success message, then refresh
                setTimeout(() => {
                    this.loadDirectory(this.currentPath);
                }, 500);
            } else {
                throw new Error(result.error || "Delete operation failed");
            }
        } catch (error) {
            console.error("Delete error:", error);
            this.showError(`Failed to delete "${name}": ${error.message}`);
        } finally {
            this.showLoadingOverlay(false);
        }
    }

    renameItem(path, currentName) {
        document.getElementById("rename-input").value = currentName;
        this.currentRenamePath = path;
        this.showModal("rename-modal");
        document.getElementById("rename-input").focus();
        document.getElementById("rename-input").select();
    }

    async confirmRename() {
        const newName = document.getElementById("rename-input").value.trim();
        if (!newName) {
            this.showWarning("Please enter a valid name");
            return;
        }

        this.showLoadingOverlay(true, "Renaming...");

        try {
            const response = await fetch("/api/rename", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    oldPath: this.currentRenamePath,
                    newName: newName,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(
                    `Server error (${response.status}): ${errorText}`,
                );
            }

            const result = await response.json();
            if (result.success) {
                this.hideModal("rename-modal");
                this.showSuccess("Item renamed successfully");
                setTimeout(() => {
                    this.loadDirectory(this.currentPath);
                }, 500);
            } else {
                throw new Error(result.error || "Rename failed");
            }
        } catch (error) {
            console.error("Rename error:", error);
            this.showError(`Failed to rename: ${error.message}`);
        } finally {
            this.showLoadingOverlay(false);
        }
    }

    showNewFolderModal() {
        document.getElementById("new-folder-input").value = "";
        this.showModal("new-folder-modal");
        document.getElementById("new-folder-input").focus();
    }

    async confirmNewFolder() {
        const folderName = document
            .getElementById("new-folder-input")
            .value.trim();
        if (!folderName) return;

        try {
            const response = await fetch("/api/mkdir", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    path: this.currentPath,
                    name: folderName,
                }),
            });

            const result = await response.json();
            if (result.success) {
                this.hideModal("new-folder-modal");
                this.loadDirectory(this.currentPath); // Refresh
                this.showSuccess("Folder created successfully");
            } else {
                throw new Error(result.error || "Create folder failed");
            }
        } catch (error) {
            console.error("Create folder error:", error);
            this.showError(`Failed to create folder: ${error.message}`);
        }
    }

    showModal(modalId) {
        document.getElementById(modalId).classList.add("show");
    }

    hideModal(modalId) {
        document.getElementById(modalId).classList.remove("show");
    }

    showLoading(show) {
        document.getElementById("loading").style.display = show
            ? "block"
            : "none";
        document.querySelector(".file-list-container").style.display = show
            ? "none"
            : "block";
    }

    showUploadProgress(show) {
        document.getElementById("upload-progress").style.display = show
            ? "block"
            : "none";
        if (show) {
            document.getElementById("progress-text").textContent =
                "Uploading files...";
            document.getElementById("progress-fill").style.width = "50%";
        }
    }

    showError(message) {
        this.showNotification("Error", message, "error");
    }

    showSuccess(message) {
        this.showNotification("Success", message, "success");
    }

    showWarning(message) {
        this.showNotification("Warning", message, "warning");
    }

    showInfo(message) {
        this.showNotification("Info", message, "info");
    }

    showNotification(title, message, type = "info") {
        const container = document.getElementById("notification-container");

        const notification = document.createElement("div");
        notification.className = `notification ${type}`;

        const icons = {
            success: "✅",
            error: "❌",
            warning: "⚠️",
            info: "ℹ️",
        };

        notification.innerHTML = `
            <span class="notification-icon">${icons[type]}</span>
            <div class="notification-content">
                <div class="notification-title">${title}</div>
                <div class="notification-message">${message}</div>
            </div>
            <button class="notification-close" onclick="this.parentElement.remove()">×</button>
        `;

        container.appendChild(notification);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (notification.parentElement) {
                notification.remove();
            }
        }, 5000);
    }

    showLoadingOverlay(show, message = "Processing...") {
        const overlay = document.getElementById("loading-overlay");
        const spinner = overlay.querySelector(
            ".loading-spinner div:last-child",
        );

        if (show) {
            spinner.textContent = message;
            overlay.classList.add("show");
        } else {
            overlay.classList.remove("show");
        }
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        return (
            date.toLocaleDateString() +
            " " +
            date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        );
    }

    escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize the file manager when the page loads
let fileManager;
document.addEventListener("DOMContentLoaded", () => {
    fileManager = new FileManager();
});
