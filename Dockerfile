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

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        catatonit

ENV APP_USER=piper
ENV HOME=/agent
ENV PATH=$HOME/.local/bin:$PATH
RUN usermod -d $HOME -l $APP_USER -m node && groupmod -n $APP_USER node
USER $APP_USER
WORKDIR $HOME

RUN mkdir -p $HOME/.local/share \
    && npm config set prefix $HOME/.local \
    && npm install -g \
        @mariozechner/pi-ai \
        @mariozechner/pi-coding-agent \
        @mariozechner/pi-tui \
        @sherif-fanous/pi-rtk \
        pi-powerline-footer \
        pi-provider-kiro \
    && npm cache clean --force

ENTRYPOINT ["catatonit", "-P"]
