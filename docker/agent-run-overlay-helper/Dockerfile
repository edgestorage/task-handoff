FROM alpine:3.20.3

RUN apk add --no-cache attr util-linux
COPY agent-run-overlay-helper.sh /usr/local/bin/task-handoff-agent-run-overlay-helper

ENTRYPOINT ["/usr/local/bin/task-handoff-agent-run-overlay-helper"]
