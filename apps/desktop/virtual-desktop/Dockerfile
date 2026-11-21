FROM docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

LABEL com.aria.desktop.protocol="1"
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus-x11 fonts-dejavu-core imagemagick libreoffice-writer mousepad openbox \
    python3 x11-utils xauth xclip xdotool xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 aria && useradd -u 10001 -g 10001 -d /workspace/working -M aria \
    && mkdir -p /workspace/inputs /workspace/outputs /workspace/working

COPY --chmod=755 start-desktop.sh /usr/local/bin/aria-start-desktop
ENV DISPLAY=:33 XAUTHORITY=/tmp/aria-display-auth HOME=/workspace/working GTK_USE_PORTAL=0
USER 10001:10001
ENTRYPOINT ["/usr/bin/timeout", "--signal=TERM", "2700", "/usr/local/bin/aria-start-desktop"]
