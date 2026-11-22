FROM docker.io/library/node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

LABEL com.aria.program.protocol="1"
WORKDIR /opt/aria-program
COPY package.json package-lock.json ./
RUN NODE_DISABLE_COMPILE_CACHE=1 npm ci --ignore-scripts --omit=dev --cache /tmp/aria-npm && rm -rf /tmp/aria-npm
COPY runner.mts ./
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/node", "--disable-proto=throw", "--no-addons", "--experimental-strip-types", "/opt/aria-program/runner.mts"]
