#!/usr/bin/env python3
"""Static server for the SRE Memories UI. Sends no-store so a stale cached
copy can never be the reason a change appears not to have landed."""
import http.server, socketserver, sys

class H(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        """Local-only diagnostics sink so browser-side failures are visible on disk.
        Never receives the API key itself - only its length."""
        if self.path != "/diag":
            return self.send_error(404)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace")
        with open("diag.log", "a") as f:
            f.write(body.rstrip() + "\n")
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()
    def log_message(self, fmt, *a):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % a))

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), H) as httpd:
    print(f"serving on http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()
