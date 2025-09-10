ARG GO_VERSION=1.23.4
FROM golang:${GO_VERSION} AS builder

WORKDIR /src

COPY main.go main.go

RUN set -e ; \
    CGO_ENABLED=0 \
    GOOS=linux \
    GOARCH=amd64 \
    go build -o /out/go-file-manager ./main.go

FROM gcr.io/distroless/static-debian12

ENV USER=user

WORKDIR /
COPY --from=builder /out/go-file-manager /go-file-manager
COPY static static

VOLUME [ "/data" ]

USER nonroot:nonroot

EXPOSE 8080

ENTRYPOINT ["/go-file-manager"]
