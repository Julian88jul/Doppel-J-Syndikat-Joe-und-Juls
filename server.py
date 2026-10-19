"""Test-Server fürs WLAN: liefert die Seite aus und speichert den Spielstand gemeinsam.

Start:   python server.py        (Port 8123, optional: python server.py 9000)
Dann auf PC und Handy im selben WLAN die angezeigte Adresse öffnen. Alle Geräte teilen sich
denselben Spielstand, ganz ohne Firebase. Für Spieler in verschiedenen Netzen braucht es
weiterhin eine echte Datenbank (Firebase) oder einen öffentlich erreichbaren Server.
"""
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(ROOT, '.djs-server-db.json')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123

lock = threading.Lock()
try:
    with open(DB_FILE, encoding='utf-8') as f:
        data = json.load(f)
except Exception:
    data = {}


def parts(path):
    return [p for p in path.split('/') if p]


def get_at(path):
    node = data
    for p in parts(path):
        if not isinstance(node, dict) or p not in node:
            return None
        node = node[p]
    return node


def set_at(path, value):
    """Wie Firebase: ein null-Wert löscht den Eintrag."""
    global data
    ps = parts(path)
    if not ps:
        data = value if isinstance(value, dict) else {}
        return
    node = data
    for p in ps[:-1]:
        if not isinstance(node.get(p), dict):
            node[p] = {}
        node = node[p]
    if value is None:
        node.pop(ps[-1], None)
    else:
        node[ps[-1]] = value


def save():
    tmp = DB_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, DB_FILE)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # ruhig bleiben

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == '/api/ping':
            return self._json({'ok': True})
        if url.path == '/api/db':
            path = urllib.parse.parse_qs(url.query).get('path', [''])[0]
            with lock:
                return self._json({'value': get_at(path)})
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != '/api/db':
            return self._json({'error': 'not found'}, 404)
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            op, path, value = body.get('op'), body.get('path', ''), body.get('value')
        except Exception:
            return self._json({'error': 'bad request'}, 400)
        with lock:
            if op == 'set':
                set_at(path, value)
            elif op == 'update' and isinstance(value, dict):
                for key, val in value.items():
                    set_at(f"{path}/{key}", val)
            else:
                return self._json({'error': 'bad op'}, 400)
            save()
        return self._json({'ok': True})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.'):
                ips.add(ip)
    except Exception:
        pass
    return sorted(ips)


if __name__ == '__main__':
    print(f"Spiel läuft auf http://localhost:{PORT}/index.html")
    for ip in lan_ips():
        print(f"Im WLAN:  http://{ip}:{PORT}/index.html")
    print("Gemeinsamer Spielstand für alle Geräte in diesem Netz. Beenden mit Strg+C.")
    Server(('', PORT), Handler).serve_forever()
