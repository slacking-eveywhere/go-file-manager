FROM golang:1.23 AS builder

ARG GO_VERSION=1.23.4
WORKDIR /src

COPY main.go main.go
COPY static/ static/

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/go-file-manager ./...

FROM gcr.io/distroless/base-debian12

WORKDIR /
COPY --from=builder /out/go-file-manager /go-file-manager

USER nonroot:nonroot
ENTRYPOINT ["/go-file-manager"]
