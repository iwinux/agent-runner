FROM debian:trixie-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/rtk-install.sh https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh \
    && bash /tmp/rtk-install.sh

FROM debian:trixie-slim
COPY --from=builder /root/.local/bin/rtk /usr/local/bin/
COPY --exclude=*.tsv pi/fetched/ /usr/local/share/pi/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        catatonit

ARG APP_UID=1000
ARG APP_GID=1000

ENV APP_USER=piper
ENV HOME=/agent
ENV PATH=$HOME/.local/bin:$PATH

RUN groupadd --gid="$APP_GID" --non-unique "$APP_USER" \
    && useradd --uid="$APP_UID" --gid="$APP_GID" --home-dir="$HOME" --create-home "$APP_USER"

USER $APP_USER
WORKDIR $HOME
ENTRYPOINT ["catatonit", "-P"]
