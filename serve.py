# -*- coding: utf-8 -*-
"""Serve the storyboard tool (with HTTP Range support so <video> can seek).

Usage: python serve.py [port]
"""
import http.server
import os
import re
import sys
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
os.chdir(os.path.dirname(os.path.abspath(__file__)))

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class Handler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler + single-range GET (needed for video seeking)."""

    def log_message(self, *args):
        pass

    def send_head(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()
        m = RANGE_RE.match(rng)
        if not m:
            return super().send_head()
        size = os.path.getsize(path)
        start = int(m.group(1)) if m.group(1) else 0
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_error(416, "Requested Range Not Satisfiable")
            return None
        f = open(path, "rb")
        f.seek(start)
        self.range_length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self.range_length))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        n = getattr(self, "range_length", None)
        if n is None:
            return super().copyfile(source, outputfile)
        self.range_length = None
        remaining = n
        while remaining > 0:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)


if __name__ == "__main__":
    url = f"http://localhost:{PORT}/"
    print(f"Storyboard → {url}   (Ctrl+C 停止)")
    webbrowser.open(url)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
