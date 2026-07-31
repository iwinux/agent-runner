FROM debian:trixie-slim
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
