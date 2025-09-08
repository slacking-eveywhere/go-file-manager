# Étape de build
FROM golang:1.23 AS builder

# Variables de build
ARG GO_VERSION=1.23.4
WORKDIR /src

# Copier le code source
COPY . .

# Compiler en binaire statique
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/app ./...

# Étape finale minimale (distroless)
FROM gcr.io/distroless/base-debian12

WORKDIR /
COPY --from=builder /out/app /app

USER nonroot:nonroot
ENTRYPOINT ["/app"]
