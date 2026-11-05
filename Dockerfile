FROM node:24.22.1-bookworm-slim

ENV SHELL=/bin/bash

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates bubblewrap build-essential git openssh-client python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8899
CMD ["npm", "start"]
