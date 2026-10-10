"""Check the local JSON API without issuing recurring upstream search queries."""

import json
import sys
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    request = urllib.request.Request(
        "http://127.0.0.1:8080/config",
        headers={
            "Accept": "application/json",
            "X-Forwarded-For": "127.0.0.1",
            "X-Real-IP": "127.0.0.1",
        },
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=3) as response:
        content = response.read(1_000_001)
    if len(content) > 1_000_000:
        raise ValueError("Oversized configuration")
    config = json.loads(content)
    engines = config.get("engines", [])
    if not any(
        isinstance(engine, dict)
        and engine.get("enabled") is not False
        and engine.get("disabled") is not True
        and "general" in engine.get("categories", [])
        for engine in engines
    ):
        raise ValueError("No enabled general search engines")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("SearXNG JSON API is not ready", file=sys.stderr)
        sys.exit(1)
