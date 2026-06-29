# Go File Manager

A web-based dual-panel file manager built with Go and vanilla JavaScript. Browse a local folder and a remote server side-by-side, transfer files both ways, and compare folders. Single Go file plus a static frontend. No bloats and shits.

## Features

- **Dual-panel view**: Local folder on the left, remote server on the right (FileZilla-style)
- **Local browsing**: Uses the File System Access API (Chrome 86+, Firefox 111+) to navigate local files
- **Transfers**: Upload local to remote and download remote to local, recursively, with conflict resolution
- **Compare folders**: Show files only-local, only-remote, or differing by size/date
- **File operations**: Delete, rename, move, create folders on the remote
- **Select & open**: Single click selects the transfer target, double click opens a folder
- **File info**: Sizes, modification dates, types

## Installation

1. Clone or download this repository
2. Make sure you have Go installed (version 1.26 or later)
3. Navigate to the project directory
4. Makefile, Docker image and bake recipe provided.

## Configuration

The application uses environment variables for configuration:

- `FILES_ROOT_DIR`: The root directory to serve files from (defaults to current directory)
- `PORT`: The port to run the server on (defaults to 8080)

## Usage

### Starting the Server

```bash
make run

# Or with overrides
make run FILES_ROOT_DIR=/path/to/your/files PORT=3000
```

### Starting as docker image

Starting the docker image is pretty straightforward.
Only env var `FILES_ROOT_DIR` is mandatory.

You have to adjust user and volume rights.
In the exemple below, the volume `data_test` belong to a user with UID:GID=1000:1000.
```bash
docker run -it --rm \
	-e FILES_ROOT_DIR=/data \
	--user 1000:1000 \
	-v data_test:/data \
	-p 8080:8080  \
	go-file-manager
```

### Accessing the Application

Open your web browser and navigate to:
```
http://localhost:8080
```

## Security Features

- Path traversal protection: Prevents access outside the root directory
- Input validation: Validates all file paths and names
- Safe file operations: Uses Go's standard library for secure file handling

## API Endpoints

The application provides a REST API:

- `GET /api/list?path=<path>`: List directory contents
- `GET /api/ls?path=<path>`: List subdirectories only
- `GET /api/download?path=<path>`: Download a file
- `POST /api/upload`: Upload a file
- `DELETE /api/delete`: Delete a file or folder
- `POST /api/rename`: Rename a file or folder
- `POST /api/move`: Move a file or folder
- `POST /api/mkdir`: Create a new directory

## Project Structure

```
files_manager/
├── main.go              # Go server with API endpoints
├── static/
│   ├── index.html       # Main HTML page
│   ├── style.css        # CSS styling
│   └── script.js        # JavaScript file manager logic
├── Makefile             # Build, run, docker targets
├── go.mod               # Go module file
└── README.md            # This file
```

## Building for Production

```bash
make build
./build/go-file-manager
```

## License

This project is open source and available under the MIT License.
