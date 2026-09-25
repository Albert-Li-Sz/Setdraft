FROM python:3.14-slim-trixie AS python-runtime

FROM gcc:16.2.0-trixie@sha256:28365a1efe31883fd29f9fce27811b731e815f9f9b2db16b0e1f0d99fcb3dae5
COPY --from=python-runtime /usr/local /usr/local
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-21-jdk-headless unzip \
    && rm -rf /var/lib/apt/lists/*
RUN test "$(g++ -dumpfullversion)" = "16.2.0" && python3 --version && javac -version
WORKDIR /work
COPY testlib/testlib.h /opt/testlib/testlib.h
