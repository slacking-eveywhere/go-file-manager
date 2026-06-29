BINARY     := go-file-manager
GO_VERSION := 1.26.4
REGISTRY   ?=
BUILD_DIR  := build

FILES_ROOT_DIR ?= /tmp/go-file-manager-data
PORT           ?= 8080

_REGISTRY_PREFIX := $(if $(REGISTRY),$(REGISTRY)/,)

.PHONY: all build run docker-build docker-bake clean help

all: build

build:
	mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 go build -o $(BUILD_DIR)/$(BINARY) ./main.go

run: build
	# FILES_ROOT_DIR must be owned by the user running this command
	mkdir -p $(FILES_ROOT_DIR)
	FILES_ROOT_DIR=$(FILES_ROOT_DIR) PORT=$(PORT) ./$(BUILD_DIR)/$(BINARY)

docker-build:
	docker build \
		--build-arg GO_VERSION=$(GO_VERSION) \
		-t $(_REGISTRY_PREFIX)$(BINARY):$(GO_VERSION) \
		-t $(_REGISTRY_PREFIX)$(BINARY):latest \
		.

docker-bake:
	GO_VERSION=$(GO_VERSION) REGISTRY=$(REGISTRY) docker buildx bake

clean:
	rm -rf $(BUILD_DIR)

help:
	@echo "Targets:"
	@echo "  build         compile binary into $(BUILD_DIR)/"
	@echo "  run           build then run locally (FILES_ROOT_DIR=$(FILES_ROOT_DIR), PORT=$(PORT))"
	@echo "  docker-build  build image with docker build"
	@echo "  docker-bake   build image via docker-bake.hcl"
	@echo "  clean         remove $(BUILD_DIR)/"
	@echo ""
	@echo "Overridable vars: REGISTRY, GO_VERSION, FILES_ROOT_DIR, PORT"
	@echo "Note: REGISTRY must include trailing slash if using a sub-path (e.g. myregistry.io/org/)"
