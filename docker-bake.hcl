variable "IMAGE" {
  default = "wireguard-control"
}

variable "VERSION" {
  default = "dev"
}

group "default" {
  targets = ["server", "mikrotik"]
}

target "server" {
  context = "."
  dockerfile = "Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${IMAGE}:${VERSION}", "${IMAGE}:latest"]
}

target "mikrotik" {
  context = "."
  dockerfile = "Dockerfile.mikrotik"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${IMAGE}:mikrotik-${VERSION}", "${IMAGE}:mikrotik"]
}
