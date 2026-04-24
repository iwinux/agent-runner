FROM node:24-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/rtk-install.sh https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh \
    && bash /tmp/rtk-install.sh

FROM node:24-slim
COPY --from=builder /root/.local/bin/rtk /usr/local/bin/
COPY --exclude=*.tsv pi-bundle/ /usr/local/share/pi/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        catatonit

ARG APP_UID=1000
ARG APP_GID=1000

ENV APP_USER=piper
ENV HOME=/agent
ENV PATH=$HOME/.local/bin:$PATH

RUN groupmod -g "$APP_GID" -n "$APP_USER" node \
    && usermod -u "$APP_UID" -g "$APP_GID" -d "$HOME" -l "$APP_USER" -m node \
    && chown -R "$APP_UID:$APP_GID" "$HOME"

USER $APP_USER
WORKDIR $HOME

RUN mkdir -p $HOME/.config $HOME/.local/share \
    && npm config set prefix $HOME/.local \
    && npm install -g \
        @mariozechner/pi-ai@0.70.0 \
        @mariozechner/pi-coding-agent@0.70.0 \
        @mariozechner/pi-tui@0.70.0 \
        @sherif-fanous/pi-rtk \
        pi-powerline-footer \
        pi-provider-kiro \
        typebox@1.1.24 \
    && npm cache clean --force

ENTRYPOINT ["catatonit", "-P"]
