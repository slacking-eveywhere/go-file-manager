variable "GO_VERSION" {
  default = "1.23.4"
}

variable "REGISTRY" {
  default = ""
}

group "default" {
  targets = ["go-file-manager"]
}

target "go-file-manager" {
  context    = "."
  dockerfile = "Dockerfile"
  args = {
    GO_VERSION = "${GO_VERSION}"
  }
  tags = ["${REGISTRY}/go-file-manager:${GO_VERSION}", "${REGISTRY}/go-file-manager:latest"]
}
