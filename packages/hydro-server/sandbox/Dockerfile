FROM python:3.14-slim-trixie AS python-runtime

FROM gcc:15.2.0-trixie@sha256:3ae15afe768b06d0c0fe088d822ba5f8045c26630bdacc8d8e7713cf5d8e7289
COPY --from=python-runtime /usr/local /usr/local
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-21-jdk-headless unzip \
    && rm -rf /var/lib/apt/lists/*
RUN test "$(g++ -dumpfullversion)" = "15.2.0" && python3 --version && javac -version
WORKDIR /work
COPY testlib/testlib.h /opt/testlib/testlib.h
