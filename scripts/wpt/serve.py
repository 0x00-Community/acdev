import json
import os
import sys

wpt = os.path.abspath(sys.argv[1])
sys.path.insert(0, wpt)
sys.path.insert(0, os.path.join(wpt, "tools"))

import localpaths  # noqa: E402,F401
from serve import serve  # noqa: E402

bind = {}


def start(logger, config, routes, mp_context, log_handlers, **kwargs):
    ports = {scheme: [bind.get(port, port) if port else port for port in ports] for scheme, ports in config.ports.items()}
    logger.info("advertised ports %r, bound %r" % (dict(config.ports), ports))
    return serve.start_servers(logger, config["server_host"], ports, config.paths, routes, config["bind_address"], config, mp_context, log_handlers, **kwargs)


if __name__ == "__main__":
    os.chdir(wpt)
    bind.update({int(k): int(v) for k, v in json.loads(sys.argv[3]).items()})
    serve.start = start
    serve.run(config_path=sys.argv[2], doc_root=None, h2=False, webtransport_h3=False, websocket_h3=False, dns=False)
