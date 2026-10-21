fetch:
    @scripts/fetch-pi-packages.sh

sync:
    @rsync -avhz --delete-delay pi/fetched/extensions/ ~/.pi/agent/extensions/

build:
    @docker buildx build --load \
        --build-arg APP_UID=$(id -u) \
        --build-arg APP_GID=$(id -g) \
        -t agent-runner:latest .

rpc:
    @printf '{"id":"1","type":"get_state"}\n' \
        | docker run --rm -i --entrypoint pi agent-runner:latest --mode rpc --no-session --offline
