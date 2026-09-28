#!/usr/bin/env python3
"""De statische server voor de testrun, met caching uit en een SPA-fallback.

Waarom niet gewoon `python3 -m http.server`: die stuurt alleen `Last-Modified`
en geen `Cache-Control`. Een browser mag een antwoord zonder cache-instructie
dan naar eigen inzicht hergebruiken, en `main.dart.js` heet elke build
hetzelfde. Dan zit je een nieuwe build te testen terwijl je de oude bekijkt —
en dat kost een halve middag voordat je het merkt.

Dit is een testrun: er is geen enkele reden om iets te bewaren. `no-store` zegt
dat ook, en dan is wat je ziet altijd wat er net gebouwd is.
"""

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        """Onbekend pad? Dan index.html, net als `try_files` op de server.

        De app schrijft zijn routes sinds `useCleanUrls()` in het pad en niet
        meer achter een `#`. Een herlaadactie op /decks vraagt dus een bestand
        op dat niet bestaat. Zonder deze regel geeft de testrun daar een 404
        terwijl het op productie gewoon werkt — precies het soort verschil dat
        je pas na de deploy ontdekt.
        """
        path = self.translate_path(self.path)
        exists = os.path.exists(path) and (
            not os.path.isdir(path) or os.path.exists(os.path.join(path, "index.html"))
        )
        if not exists:
            self.path = "/index.html"
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    handler = partial(NoCacheHandler, directory=directory)
    with ThreadingHTTPServer(("0.0.0.0", port), handler) as server:
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
