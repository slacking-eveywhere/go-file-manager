variable "GO_VERSION" {
  default = "1.23.4"
}

variable "REGISTRY" {
  default = ""
}

group "default" {
  targets = ["app"]
}

target "app" {
  context    = "."
  dockerfile = "Dockerfile"
  args = {
    GO_VERSION = "${GO_VERSION}"
  }
  tags = ["${REGISTRY}myapp:${GO_VERSION}", "${REGISTRY}myapp:latest"]
}
