# Go File Manager

A web-based hierarchical file manager built with Go and vanilla JavaScript. This application provides a clean interface to browse, manage, and upload files through a web browser. One go file and one html file. No bloats and shits.

## Features

- **Hierarchical File Browsing**: Navigate through folders like a traditional file explorer
- **File Operations**: Delete and rename files and folders
- **Create Folders**: Create new directories
- **File Information**: View file sizes, modification dates, and file types
- **Conflict Resolution**: Handle file upload conflicts with user choice

## Installation

1. Clone or download this repository
2. Make sure you have Go installed (version 1.21 or later)
3. Navigate to the project directory
4. Docker image and bake recipe provided.

## Configuration

The application uses environment variables for configuration:

- `FILES_ROOT_DIR`: The root directory to serve files from (defaults to current directory)
- `PORT`: The port to run the server on (defaults to 8080)

## Usage

### Starting the Server

```bash
# Use current directory as root
go run main.go

# Or specify a custom root directory
FILES_ROOT_DIR=/path/to/your/files go run main.go

# Or specify a custom port
PORT=3000 go run main.go

# Or both
FILES_ROOT_DIR=/path/to/your/files PORT=3000 go run main.go
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
- `POST /api/upload`: Upload a file
- `DELETE /api/delete`: Delete a file or folder
- `POST /api/rename`: Rename a file or folder
- `POST /api/mkdir`: Create a new directory

## Project Structure

```
files_manager/
├── main.go              # Go server with API endpoints
├── static/
│   ├── index.html       # Main HTML page
│   ├── style.css        # CSS styling
│   └── script.js        # JavaScript file manager logic
├── go.mod               # Go module file
└── README.md            # This file
```

## Building for Production

```bash
# Build the binary
go build -o file-manager main.go

# Run the binary
./file-manager
```

## License

This project is open source and available under the MIT License.
