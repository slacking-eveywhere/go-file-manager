package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const maxUploadBytes = 32 << 20

type FileInfo struct {
	Name          string    `json:"name"`
	Path          string    `json:"path"`
	IsDir         bool      `json:"isDir"`
	Size          int64     `json:"size"`
	ModTime       time.Time `json:"modTime"`
	SizeFormatted string    `json:"sizeFormatted"`
}

type DirectoryContent struct {
	CurrentPath string     `json:"currentPath"`
	ParentPath  string     `json:"parentPath"`
	Files       []FileInfo `json:"files"`
}

type server struct {
	rootDir   string
	staticDir string
}

func newServer(rootDir, staticDir string) *server {
	return &server{rootDir: rootDir, staticDir: staticDir}
}

// isInsideRoot checks that fullPath (already absolute) is rootDir itself or a
// descendant of it. The trailing-separator check prevents the prefix collision
// between e.g. /data/files and /data/files-evil.
func (s *server) isInsideRoot(fullPath string) bool {
	return fullPath == s.rootDir || strings.HasPrefix(fullPath, s.rootDir+string(filepath.Separator))
}

func main() {
	rawRoot := os.Getenv("FILES_ROOT_DIR")
	if rawRoot == "" {
		rawRoot = "."
		log.Println("FILES_ROOT_DIR not set, using current directory")
	}

	rootDir, err := filepath.Abs(rawRoot)
	if err != nil {
		log.Fatal("Error getting absolute path:", err)
	}

	rootDirStat, err := os.Stat(rootDir)
	if err != nil {
		log.Fatal("Error getting directory stats:", err)
	}

	if !rootDirStat.IsDir() {
		log.Fatal("Root dir path must be a folder.")
	}

	stat := rootDirStat.Sys().(*syscall.Stat_t)
	fmt.Printf("Root dir stats UID: %d, GID: %d\n", stat.Uid, stat.Gid)

	currentUser, err := user.Current()
	if err != nil {
		log.Fatal("Error retrieving current user, aborting:", err)
	}

	currentUID, err := strconv.ParseUint(currentUser.Uid, 10, 32)
	if err != nil {
		log.Fatal("Error parsing current user UID:", err)
	}
	currentGID, err := strconv.ParseUint(currentUser.Gid, 10, 32)
	if err != nil {
		log.Fatal("Error parsing current user GID:", err)
	}

	if stat.Uid != uint32(currentUID) || stat.Gid != uint32(currentGID) {
		fmt.Printf("Current user UID: %s, GID: %s\n", currentUser.Uid, currentUser.Gid)
		log.Fatal("UID/GID is not the same as the owner of the root dir path")
	}

	staticDir, err := filepath.Abs("./static")
	if err != nil {
		log.Fatal("Error resolving static dir:", err)
	}

	srv := newServer(rootDir, staticDir)

	log.Printf("Starting file manager server with root directory: %s", rootDir)

	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir(staticDir))))
	http.HandleFunc("/api/list", srv.handleListDirectory)
	http.HandleFunc("/api/upload", srv.handleUpload)
	http.HandleFunc("/api/delete", srv.handleDelete)
	http.HandleFunc("/api/rename", srv.handleRename)
	http.HandleFunc("/api/mkdir", srv.handleMkdir)
	http.HandleFunc("/api/move", srv.handleMove)
	http.HandleFunc("/api/ls", srv.handleLs)
	http.HandleFunc("/api/download", srv.handleDownload)
	http.HandleFunc("/", srv.handleIndex)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Server starting on port %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, filepath.Join(s.staticDir, "index.html"))
}

func (s *server) handleListDirectory(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestedPath := r.URL.Query().Get("path")
	if requestedPath == "" {
		requestedPath = "/"
	}

	log.Printf("Listing directory: %s", requestedPath)

	fullPath, err := filepath.Abs(filepath.Join(s.rootDir, requestedPath))
	if err != nil {
		log.Printf("Error getting absolute path for %s: %v", requestedPath, err)
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	if !s.isInsideRoot(fullPath) {
		log.Printf("Access denied: %s is outside root %s", fullPath, s.rootDir)
		http.Error(w, "Access denied", http.StatusForbidden)
		return
	}

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

		files = append(files, FileInfo{
			Name:          entry.Name(),
			Path:          filepath.Join(requestedPath, entry.Name()),
			IsDir:         entry.IsDir(),
			Size:          entryInfo.Size(),
			ModTime:       entryInfo.ModTime(),
			SizeFormatted: formatSize(entryInfo.Size()),
		})
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

	parentPath := ""
	if requestedPath != "/" && requestedPath != "" {
		parentPath = filepath.Dir(requestedPath)
		if parentPath == "." {
			parentPath = "/"
		}
	}

	log.Printf("Current path: %s, Parent path: %s, Files count: %d", requestedPath, parentPath, len(files))

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(DirectoryContent{
		CurrentPath: requestedPath,
		ParentPath:  parentPath,
		Files:       files,
	}); err != nil {
		log.Printf("Error encoding list response: %v", err)
	}
}

func (s *server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		http.Error(w, "Error parsing form", http.StatusBadRequest)
		return
	}

	targetPath := r.FormValue("path")
	if targetPath == "" {
		targetPath = "/"
	}

	overwrite := r.FormValue("overwrite") == "true"
	createPath := r.FormValue("createPath") == "true"

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Error getting uploaded file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	targetDir, err := filepath.Abs(filepath.Join(s.rootDir, targetPath))
	if err != nil || !s.isInsideRoot(targetDir) {
		http.Error(w, "Invalid target path", http.StatusBadRequest)
		return
	}

	if createPath {
		if err := os.MkdirAll(targetDir, 0755); err != nil {
			http.Error(w, "Error creating directory structure", http.StatusInternalServerError)
			return
		}
	}

	safeFilename := filepath.Base(header.Filename)
	targetFile, err := filepath.Abs(filepath.Join(targetDir, safeFilename))
	if err != nil || !s.isInsideRoot(targetFile) {
		http.Error(w, "Invalid target path", http.StatusBadRequest)
		return
	}

	if _, err := os.Stat(targetFile); err == nil && !overwrite {
		w.Header().Set("Content-Type", "application/json")
		if encErr := json.NewEncoder(w).Encode(map[string]interface{}{
			"success":  false,
			"error":    "File already exists",
			"conflict": true,
			"filename": safeFilename,
		}); encErr != nil {
			log.Printf("Error encoding conflict response: %v", encErr)
		}
		return
	}

	dst, err := os.Create(targetFile)
	if err != nil {
		http.Error(w, "Error creating file", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	if _, err = io.Copy(dst, file); err != nil {
		http.Error(w, "Error copying file", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File uploaded successfully",
	}); err != nil {
		log.Printf("Error encoding upload response: %v", err)
	}
}

func (s *server) handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != "DELETE" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var requestData struct {
		Path string `json:"path"`
	}

	if err := json.NewDecoder(r.Body).Decode(&requestData); err != nil {
		log.Printf("Error decoding delete request: %v", err)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("Delete request for path: %s", requestData.Path)

	fullPath, err := filepath.Abs(filepath.Join(s.rootDir, requestData.Path))
	if err != nil || !s.isInsideRoot(fullPath) {
		log.Printf("Invalid path for delete: %s", requestData.Path)
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	if fullPath == s.rootDir {
		http.Error(w, "Cannot delete root directory", http.StatusForbidden)
		return
	}

	log.Printf("Deleting: %s", fullPath)

	if err := os.RemoveAll(fullPath); err != nil {
		log.Printf("Error deleting %s: %v", fullPath, err)
		http.Error(w, "Error deleting file", http.StatusInternalServerError)
		return
	}

	log.Printf("Successfully deleted: %s", fullPath)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File deleted successfully",
	}); err != nil {
		log.Printf("Error encoding delete response: %v", err)
	}
}

func (s *server) handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var requestData struct {
		OldPath string `json:"oldPath"`
		NewName string `json:"newName"`
	}

	if err := json.NewDecoder(r.Body).Decode(&requestData); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	oldFullPath, err := filepath.Abs(filepath.Join(s.rootDir, requestData.OldPath))
	if err != nil || !s.isInsideRoot(oldFullPath) {
		http.Error(w, "Invalid old path", http.StatusBadRequest)
		return
	}

	newFullPath, err := filepath.Abs(filepath.Join(filepath.Dir(oldFullPath), filepath.Base(requestData.NewName)))
	if err != nil || !s.isInsideRoot(newFullPath) {
		http.Error(w, "Invalid new path", http.StatusBadRequest)
		return
	}

	if err := os.Rename(oldFullPath, newFullPath); err != nil {
		http.Error(w, "Error renaming file", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File renamed successfully",
	}); err != nil {
		log.Printf("Error encoding rename response: %v", err)
	}
}

func (s *server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var requestData struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}

	if err := json.NewDecoder(r.Body).Decode(&requestData); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	fullPath, err := filepath.Abs(filepath.Join(s.rootDir, requestData.Path, requestData.Name))
	if err != nil || !s.isInsideRoot(fullPath) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	if err := os.MkdirAll(fullPath, 0755); err != nil {
		http.Error(w, "Error creating directory", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Directory created successfully",
	}); err != nil {
		log.Printf("Error encoding mkdir response: %v", err)
	}
}

func (s *server) handleMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var requestData struct {
		From string `json:"from"`
		To   string `json:"to"`
	}

	if err := json.NewDecoder(r.Body).Decode(&requestData); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	fromFullPath, err := filepath.Abs(filepath.Join(s.rootDir, requestData.From))
	if err != nil || !s.isInsideRoot(fromFullPath) {
		http.Error(w, "Invalid source path", http.StatusBadRequest)
		return
	}

	toFullPath, err := filepath.Abs(filepath.Join(s.rootDir, requestData.To, filepath.Base(requestData.From)))
	if err != nil || !s.isInsideRoot(toFullPath) {
		http.Error(w, "Invalid destination path", http.StatusBadRequest)
		return
	}

	if _, err := os.Stat(toFullPath); err == nil {
		http.Error(w, "Destination already exists", http.StatusConflict)
		return
	}

	if err := os.Rename(fromFullPath, toFullPath); err != nil {
		if errors.Is(err, syscall.EXDEV) {
			http.Error(w, "Cannot move across filesystems", http.StatusUnprocessableEntity)
			return
		}
		http.Error(w, "Error moving file", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File moved successfully",
	}); err != nil {
		log.Printf("Error encoding move response: %v", err)
	}
}

func (s *server) handleLs(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestedPath := r.URL.Query().Get("path")
	if requestedPath == "" {
		requestedPath = "/"
	}

	fullPath, err := filepath.Abs(filepath.Join(s.rootDir, requestedPath))
	if err != nil || !s.isInsideRoot(fullPath) {
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

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(DirectoryContent{
		CurrentPath: requestedPath,
		ParentPath:  parentPath,
		Files:       dirs,
	}); err != nil {
		log.Printf("Error encoding ls response: %v", err)
	}
}

func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestedPath := r.URL.Query().Get("path")
	if requestedPath == "" {
		http.Error(w, "Missing path parameter", http.StatusBadRequest)
		return
	}

	fullPath, err := filepath.Abs(filepath.Join(s.rootDir, requestedPath))
	if err != nil || !s.isInsideRoot(fullPath) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	if info.IsDir() {
		http.Error(w, "Path is a directory", http.StatusBadRequest)
		return
	}

	f, err := os.Open(fullPath)
	if err != nil {
		http.Error(w, "Cannot open file", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	ext := filepath.Ext(info.Name())
	contentType := mime.TypeByExtension(ext)
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", "attachment; filename="+strconv.Quote(info.Name()))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))

	if _, err := io.Copy(w, f); err != nil {
		log.Printf("Error streaming download for %s: %v", fullPath, err)
	}
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
