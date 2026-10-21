FROM debian:trixie-slim

ARG APP_UID=1000
ARG APP_GID=1000

ENV APP_USER=piper
ENV HOME=/agent
ENV PATH=$HOME/.local/bin:$PATH
ENV PI_HOME=$HOME/.local/share/bun/tools/pi

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        catatonit \
    && apt clean \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid="$APP_GID" --non-unique "$APP_USER" \
    && useradd --uid="$APP_UID" --gid="$APP_GID" --home-dir="$HOME" --create-home "$APP_USER"

USER $APP_USER
WORKDIR $HOME

COPY --from=docker.io/oven/bun:1.4.3-slim /usr/local/bin/bun /usr/local/bin/bun
COPY --chown=$APP_UID:$APP_GID pi/package/ $PI_HOME/
COPY --chown=$APP_UID:$APP_GID pi/bin/ $HOME/.local/bin/

RUN cd "$PI_HOME" \
    && bun install --frozen-lockfile --production \
    && rm -rf "$HOME/.bun/install/cache"

COPY --exclude=*.tsv --chown=$APP_UID:$APP_GID pi/fetched/ $HOME/.pi/agent/
COPY --chown=$APP_UID:$APP_GID pi/settings.json $HOME/.pi/agent/settings.json

ENTRYPOINT ["catatonit", "--"]
