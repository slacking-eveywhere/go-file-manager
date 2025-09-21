package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

type FileInfo struct {
	Name          string    `json:"name"`
	Path          string    `json:"path"`
	IsDir         bool      `json:"isDir"`
	Size          int64     `json:"size"`
	ModTime       time.Time `json:"modTime"`
	CreateTime    time.Time `json:"createTime"`
	SizeFormatted string    `json:"sizeFormatted"`
}

type DirectoryContent struct {
	CurrentPath string     `json:"currentPath"`
	ParentPath  string     `json:"parentPath"`
	Files       []FileInfo `json:"files"`
}

var rootDir string

func main() {
	// Get root directory from environment variable
	rootDir = os.Getenv("FILES_ROOT_DIR")
	if rootDir == "" {
		rootDir = "." // Default to current directory
		log.Println("FILES_ROOT_DIR not set, using current directory")
	}

	// Ensure rootDir is absolute
	var err error
	rootDir, err = filepath.Abs(rootDir)
	if err != nil {
		log.Fatal("Error getting absolute path:", err)
	}

	// Ensure rootDir exists and is writable
	rootDirStat, err := os.Stat(rootDir)
	if err != nil {
		log.Fatal("Error getting directory stats:", err)
	}

	if !rootDirStat.IsDir() {
		log.Fatal("Root dir path must be a folder.")
	}

	stat := rootDirStat.Sys().(*syscall.Stat_t)
	fmt.Printf("Root dir stats UID: %d, GID: %d\n", stat.Uid, stat.Gid)

	// Get the user's UID launching this program
	currentUser, err := user.Current()
	if err != nil {
		log.Fatal("Error retrieving current user, aborting :", err)
	}

	if fmt.Sprint(stat.Uid) != currentUser.Uid || fmt.Sprint(stat.Gid) != currentUser.Gid {
		fmt.Printf("Current user UID: %s, GID: %s\n", currentUser.Uid, currentUser.Gid)
		log.Fatal("UID/GID is not the same as the owner of the root dir path")
	}

	log.Printf("Starting file manager server with root directory: %s", rootDir)

	// Static files
	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("./static/"))))

	// API endpoints
	http.HandleFunc("/api/list", handleListDirectory)
	http.HandleFunc("/api/upload", handleUpload)
	http.HandleFunc("/api/delete", handleDelete)
	http.HandleFunc("/api/rename", handleRename)
	http.HandleFunc("/api/mkdir", handleMkdir)
	http.HandleFunc("/api/move", handleMove)
	http.HandleFunc("/api/ls", handleLs)

	// Main page
	http.HandleFunc("/", handleIndex)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Server starting on port %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func handleIndex(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, "./static/index.html")
}

func handleListDirectory(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestedPath := r.URL.Query().Get("path")
	if requestedPath == "" {
		requestedPath = "/"
	}

	log.Printf("Listing directory: %s", requestedPath)

	// Ensure path is within root directory
	fullPath := filepath.Join(rootDir, requestedPath)
	fullPath, err := filepath.Abs(fullPath)
	if err != nil {
		log.Printf("Error getting absolute path for %s: %v", requestedPath, err)
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	// Security check: ensure path is within root directory
	if !strings.HasPrefix(fullPath, rootDir) {
		log.Printf("Access denied: %s is outside root %s", fullPath, rootDir)
		http.Error(w, "Access denied", http.StatusForbidden)
		return
	}

	// Check if path exists and is a directory
	info, err := os.Stat(fullPath)
	if err != nil {
		log.Printf("Path not found: %s (%v)", fullPath, err)
		http.Error(w, "Path not found", http.StatusNotFound)
		return
	}

	if !info.IsDir() {
		log.Printf("Path is not a directory: %s", fullPath)
		http.Error(w, "Path is not a directory", http.StatusBadRequest)
		return
	}

	// Read directory contents
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		log.Printf("Error reading directory %s: %v", fullPath, err)
		http.Error(w, "Error reading directory", http.StatusInternalServerError)
		return
	}

	var files []FileInfo
	for _, entry := range entries {
		entryInfo, err := entry.Info()
		if err != nil {
			continue
		}

		fileInfo := FileInfo{
			Name:          entry.Name(),
			Path:          filepath.Join(requestedPath, entry.Name()),
			IsDir:         entry.IsDir(),
			Size:          entryInfo.Size(),
			ModTime:       entryInfo.ModTime(),
			CreateTime:    entryInfo.ModTime(), // Shit !! Go doesn't provide creation time easily
			SizeFormatted: formatSize(entryInfo.Size()),
		}
		files = append(files, fileInfo)
	}

	sort.Slice(files, func(i int, j int) bool {
		if files[i].IsDir && !files[j].IsDir {
			return true
		}
		if !files[i].IsDir && files[j].IsDir {
			return false
		}
		return files[i].Name < files[j].Name
	})

	// Calculate parent path
	parentPath := ""
	if requestedPath != "/" && requestedPath != "" {
		parentPath = filepath.Dir(requestedPath)
		if parentPath == "." {
			parentPath = "/"
		}
	}

	log.Printf("Current path: %s, Parent path: %s, Files count: %d", requestedPath, parentPath, len(files))

	response := DirectoryContent{
		CurrentPath: requestedPath,
		ParentPath:  parentPath,
		Files:       files,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse multipart form (32 MB max)
	err := r.ParseMultipartForm(32 << 20)
	if err != nil {
		http.Error(w, "Error parsing form", http.StatusBadRequest)
		return
	}

	targetPath := r.FormValue("path")
	if targetPath == "" {
		targetPath = "/"
	}

	overwrite := r.FormValue("overwrite") == "true"
	createPath := r.FormValue("createPath") == "true"

	// Get the uploaded file
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Error getting uploaded file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Construct target file path
	targetDir := filepath.Join(rootDir, targetPath)

	// If createPath is true, ensure the directory structure exists
	if createPath {
		// Security check for targetDir
		targetDir, err = filepath.Abs(targetDir)
		if err != nil || !strings.HasPrefix(targetDir, rootDir) {
			http.Error(w, "Invalid target path", http.StatusBadRequest)
			return
		}

		// Create directory structure if it doesn't exist
		err = os.MkdirAll(targetDir, 0755)
		if err != nil {
			http.Error(w, "Error creating directory structure", http.StatusInternalServerError)
			return
		}
	}

	targetFile := filepath.Join(targetDir, header.Filename)

	// Security check
	targetFile, err = filepath.Abs(targetFile)
	if err != nil || !strings.HasPrefix(targetFile, rootDir) {
		http.Error(w, "Invalid target path", http.StatusBadRequest)
		return
	}

	// Check if file already exists
	if _, err := os.Stat(targetFile); err == nil && !overwrite {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":  false,
			"error":    "File already exists",
			"conflict": true,
			"filename": header.Filename,
		})
		return
	}

	// Create target file
	dst, err := os.Create(targetFile)
	if err != nil {
		http.Error(w, "Error creating file", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	// Copy uploaded file to target
	_, err = io.Copy(dst, file)
	if err != nil {
		http.Error(w, "Error copying file", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File uploaded successfully",
	})
}

func handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != "DELETE" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var requestData struct {
		Path string `json:"path"`
	}

	err := json.NewDecoder(r.Body).Decode(&requestData)
	if err != nil {
		log.Printf("Error decoding delete request: %v", err)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("Delete request for path: %s", requestData.Path)

	// Construct full path
	fullPath := filepath.Join(rootDir, requestData.Path)
	fullPath, err = filepath.Abs(fullPath)
	if err != nil || !strings.HasPrefix(fullPath, rootDir) {
		log.Printf("Invalid path for delete: %s", requestData.Path)
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	log.Printf("Deleting: %s", fullPath)

	// Delete file or directory
	err = os.RemoveAll(fullPath)
	if err != nil {
		log.Printf("Error deleting %s: %v", fullPath, err)
		http.Error(w, "Error deleting file", http.StatusInternalServerError)
		return
	}

	log.Printf("Successfully deleted: %s", fullPath)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File deleted successfully",
	})
}

func handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var requestData struct {
		OldPath string `json:"oldPath"`
		NewName string `json:"newName"`
	}

	err := json.NewDecoder(r.Body).Decode(&requestData)
	if err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Construct paths
	oldFullPath := filepath.Join(rootDir, requestData.OldPath)
	newFullPath := filepath.Join(filepath.Dir(oldFullPath), requestData.NewName)

	// Security checks
	oldFullPath, err = filepath.Abs(oldFullPath)
	if err != nil || !strings.HasPrefix(oldFullPath, rootDir) {
		http.Error(w, "Invalid old path", http.StatusBadRequest)
		return
	}

	newFullPath, err = filepath.Abs(newFullPath)
	if err != nil || !strings.HasPrefix(newFullPath, rootDir) {
		http.Error(w, "Invalid new path", http.StatusBadRequest)
		return
	}

	// Rename file
	err = os.Rename(oldFullPath, newFullPath)
	if err != nil {
		http.Error(w, "Error renaming file", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File renamed successfully",
	})
}

func handleMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var requestData struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}

	err := json.NewDecoder(r.Body).Decode(&requestData)
	if err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Construct full path
	fullPath := filepath.Join(rootDir, requestData.Path, requestData.Name)
	fullPath, err = filepath.Abs(fullPath)
	if err != nil || !strings.HasPrefix(fullPath, rootDir) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	// Create directory
	err = os.MkdirAll(fullPath, 0755)
	if err != nil {
		http.Error(w, "Error creating directory", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Directory created successfully",
	})
}

func handleMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var requestData struct {
		From string `json:"from"`
		To   string `json:"to"`
	}

	err := json.NewDecoder(r.Body).Decode(&requestData)
	if err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Construct paths
	fromFullPath := filepath.Join(rootDir, requestData.From)
	toFullPath := filepath.Join(rootDir, requestData.To, filepath.Base(requestData.From))

	// Security checks
	fromFullPath, err = filepath.Abs(fromFullPath)
	if err != nil || !strings.HasPrefix(fromFullPath, rootDir) {
		http.Error(w, "Invalid source path", http.StatusBadRequest)
		return
	}

	toFullPath, err = filepath.Abs(toFullPath)
	if err != nil || !strings.HasPrefix(toFullPath, rootDir) {
		http.Error(w, "Invalid destination path", http.StatusBadRequest)
		return
	}

	// Check if destination exists
	if _, err := os.Stat(toFullPath); err == nil {
		http.Error(w, "Destination already exists", http.StatusConflict)
		return
	}

	// Move file
	err = os.Rename(fromFullPath, toFullPath)
	if err != nil {
		http.Error(w, "Error moving file", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File moved successfully",
	})
}

func handleLs(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestedPath := r.URL.Query().Get("path")
	if requestedPath == "" {
		requestedPath = "/"
	}

	fullPath := filepath.Join(rootDir, requestedPath)
	fullPath, err := filepath.Abs(fullPath)
	if err != nil || !strings.HasPrefix(fullPath, rootDir) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		http.Error(w, "Error reading directory", http.StatusInternalServerError)
		return
	}

	var dirs []FileInfo
	for _, entry := range entries {
		if entry.IsDir() {
			entryInfo, err := entry.Info()
			if err != nil {
				continue
			}
			dirs = append(dirs, FileInfo{
				Name:    entry.Name(),
				Path:    filepath.Join(requestedPath, entry.Name()),
				IsDir:   true,
				ModTime: entryInfo.ModTime(),
			})
		}
	}

	sort.Slice(dirs, func(i, j int) bool {
		return dirs[i].Name < dirs[j].Name
	})

	parentPath := ""
	if requestedPath != "/" && requestedPath != "" {
		parentPath = filepath.Dir(requestedPath)
		if parentPath == "." {
			parentPath = "/"
		}
	}

	response := DirectoryContent{
		CurrentPath: requestedPath,
		ParentPath:  parentPath,
		Files:       dirs,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func formatSize(size int64) string {
	const unit = 1024
	if size < unit {
		return fmt.Sprintf("%d B", size)
	}
	div, exp := int64(unit), 0
	for n := size / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(size)/float64(div), "KMGTPE"[exp])
}
