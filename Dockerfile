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

ENV HOME=/home/piper
RUN usermod -d $HOME -l piper -m node && groupmod -n piper node
USER piper
WORKDIR $HOME

RUN mkdir -p $HOME/.local \
    && npm config set prefix $HOME/.local \
    && npm install -g @mariozechner/pi-coding-agent \
    && npm cache clean --force

CMD ["bash"]
