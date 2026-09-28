ARG PYTHON_IMAGE=python:3.14-slim-trixie
ARG GCC_IMAGE=gcc:16.2.0-trixie@sha256:28365a1efe31883fd29f9fce27811b731e815f9f9b2db16b0e1f0d99fcb3dae5
FROM ${PYTHON_IMAGE} AS python-runtime

FROM ${GCC_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/Albert-Li-Sz/setdraft" \
      org.opencontainers.image.title="Setdraft sandbox" \
      org.opencontainers.image.description="GCC, Python, Java and testlib execution environment"
COPY --from=python-runtime /usr/local /usr/local
ARG DEBIAN_MIRROR=https://deb.debian.org
RUN python3 -c 'import os,pathlib; p=pathlib.Path("/etc/apt/sources.list.d/debian.sources"); mirror=os.environ["DEBIAN_MIRROR"].rstrip("/"); p.write_text(p.read_text().replace("http://deb.debian.org",mirror).replace("http://security.debian.org",mirror))' \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends openjdk-21-jdk-headless unzip \
    && rm -rf /var/lib/apt/lists/*
RUN test "$(g++ -dumpfullversion)" = "16.2.0" && python3 --version && javac -version
WORKDIR /work
COPY testlib/testlib.h /opt/testlib/testlib.h
