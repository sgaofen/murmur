"""`etcli serve` rejects requests whose Host header isn't a loopback name plus
the listening port — the DNS-rebinding guard from the #45 security review.

Raw sockets are used so the Host header (or its absence) is exactly what the
test says; urllib would fill one in. No third-party deps, no real data.
"""
import json
import socket
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import error_codes as ec  # noqa: E402
import etcli  # noqa: E402

H = etcli._MurmurAPIHandler


def _ok_get(self):
    self._send_json({"ok": True, "via": "GET"})


def _ok_post(self):
    self._send_json({"ok": True, "via": "POST"})


class HostHeaderParseTest(unittest.TestCase):
    def test_split(self) -> None:
        cases = {
            "127.0.0.1:9100": ("127.0.0.1", 9100),
            "LOCALHOST:9100": ("localhost", 9100),
            "localhost": ("localhost", None),
            "[::1]:9100": ("::1", 9100),
            "[::1]": ("::1", None),
            " 127.0.0.1:9100 ": ("127.0.0.1", 9100),
            "127.0.0.1.evil.com:9100": ("127.0.0.1.evil.com", 9100),
        }
        for raw, want in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(H._split_host_header(raw), want)
        for bad in ("", "::1:9100", "[::1", "[::1]9100", "127.0.0.1:abc", "127.0.0.1:", "127.0.0.1:999999",
                    "127.0.0.1:-1"):
            with self.subTest(bad=bad):
                self.assertIsNone(H._split_host_header(bad))


class HostGuardHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._patches = [
            mock.patch.object(etcli, "discover_data_dir", return_value=None),
            mock.patch.object(H, "store", None),
            mock.patch.object(H, "app_lock", None),
            mock.patch.object(H, "_dispatch_get", _ok_get),
            mock.patch.object(H, "_dispatch_post", _ok_post),
        ]
        for p in cls._patches:
            p.start()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for p in cls._patches:
            p.stop()

    def raw(self, method: str, host, extra: str = "", body: bytes = b""):
        """Send one request with exactly this Host header (None = no Host)."""
        lines = [f"{method} /api/info HTTP/1.1"]
        if host is not None:
            lines.append(f"Host: {host}")
        lines.append("Connection: close")
        if body:
            lines.append("Content-Type: application/json")
            lines.append(f"Content-Length: {len(body)}")
        if extra:
            lines.append(extra)
        req = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as s:
            s.sendall(req)
            chunks = []
            while True:
                b = s.recv(65536)
                if not b:
                    break
                chunks.append(b)
        resp = b"".join(chunks)
        head, _, payload = resp.partition(b"\r\n\r\n")
        status = int(head.split(b" ", 2)[1])
        headers = head.decode("latin-1").lower()
        data = json.loads(payload.decode("utf-8")) if payload.strip() else None
        return status, data, headers

    def assert_allowed(self, host) -> None:
        status, body, _ = self.raw("GET", host)
        self.assertEqual(status, 200, (host, body))
        self.assertTrue(body["ok"])

    def assert_rejected(self, host, method="GET") -> None:
        status, body, _ = self.raw(method, host, body=b"{}" if method == "POST" else b"")
        self.assertEqual(status, 403, (host, method, body))
        self.assertEqual(body["error"], "host_not_allowed")
        self.assertEqual(body["code"], ec.HOST_NOT_ALLOWED)

    def test_loopback_names_with_the_real_port_pass(self) -> None:
        p = self.port
        for host in (f"127.0.0.1:{p}", f"localhost:{p}", f"LocalHost:{p}", f"[::1]:{p}"):
            with self.subTest(host=host):
                self.assert_allowed(host)

    def test_post_and_preflight_pass_from_the_app(self) -> None:
        p = self.port
        status, body, _ = self.raw("POST", f"127.0.0.1:{p}", body=b"{}")
        self.assertEqual((status, body["via"]), (200, "POST"))
        # The Tauri shell's preflight: Host is still 127.0.0.1:<port>, Origin is tauri://.
        status, _, headers = self.raw("OPTIONS", f"127.0.0.1:{p}", extra="Origin: tauri://localhost")
        self.assertEqual(status, 204)
        self.assertIn("access-control-allow-origin: tauri://localhost", headers)
        # Windows WebView2 origin, and the vite dev frontend.
        for origin in ("http://tauri.localhost", "http://127.0.0.1:5173", "http://localhost:5173"):
            with self.subTest(origin=origin):
                status, body, _ = self.raw("GET", f"127.0.0.1:{p}", extra=f"Origin: {origin}")
                self.assertEqual(status, 200, body)

    def test_rebinding_hosts_are_rejected(self) -> None:
        p = self.port
        for host in ("evil.com", f"evil.com:{p}", f"127.0.0.1.evil.com:{p}", f"localhost.evil.com:{p}",
                     f"evil.com:{p}@127.0.0.1", "127.0.0.1", f"127.0.0.1:{p + 1 if p < 65535 else p - 1}",
                     f"[::1]:{p}x", f"::1:{p}", f"0.0.0.0:{p}", f"127.0.0.2:{p}", ""):
            with self.subTest(host=host):
                self.assert_rejected(host)

    def test_missing_host_is_rejected(self) -> None:
        self.assert_rejected(None)

    def test_every_method_is_guarded(self) -> None:
        for method in ("GET", "POST", "OPTIONS"):
            with self.subTest(method=method):
                self.assert_rejected(f"evil.com:{self.port}", method=method)

    def test_rejection_sends_no_cors_grant(self) -> None:
        status, _, headers = self.raw("GET", f"evil.com:{self.port}", extra="Origin: http://evil.com")
        self.assertEqual(status, 403)
        self.assertNotIn("access-control-allow-origin", headers)

    def test_guard_runs_before_the_app_lock(self) -> None:
        class Locked:
            enabled = True

            def __getattr__(self, name):
                raise AssertionError("app lock consulted for a rejected Host")

        with mock.patch.object(H, "app_lock", Locked()):
            self.assert_rejected(f"evil.com:{self.port}")


class BoundHostTest(unittest.TestCase):
    """`serve --host <ip>`: that exact address is accepted too; a wildcard
    bind (0.0.0.0) does not make every name acceptable."""

    def _allowed(self, bound, host) -> bool:
        h = H.__new__(H)
        h.server = mock.Mock(server_address=bound)
        h.headers = {"Host": host}
        return h._host_allowed()

    def test_bound_address(self) -> None:
        self.assertTrue(self._allowed(("192.168.1.20", 9100), "192.168.1.20:9100"))
        self.assertTrue(self._allowed(("192.168.1.20", 9100), "127.0.0.1:9100"))
        self.assertFalse(self._allowed(("192.168.1.20", 9100), "192.168.1.21:9100"))
        self.assertFalse(self._allowed(("0.0.0.0", 9100), "0.0.0.0:9100"))
        self.assertFalse(self._allowed(("0.0.0.0", 9100), "evil.com:9100"))
        self.assertTrue(self._allowed(("0.0.0.0", 9100), "localhost:9100"))
        # IPv6 server_address is a 4-tuple.
        self.assertTrue(self._allowed(("::1", 9100, 0, 0), "[::1]:9100"))
        self.assertTrue(self._allowed(("::", 9100, 0, 0), "[::1]:9100"))
        self.assertFalse(self._allowed(("::", 9100, 0, 0), "[::]:9100"))
        # A server on port 80: a browser leaves the port out.
        self.assertTrue(self._allowed(("127.0.0.1", 80), "localhost"))
        self.assertFalse(self._allowed(("127.0.0.1", 9100), "localhost"))


if __name__ == "__main__":
    unittest.main()
