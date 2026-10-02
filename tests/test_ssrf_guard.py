#!/usr/bin/env python3
"""SSRF-guard tests for dashboard/plugin_api.py.

Run: python3 tests/test_ssrf_guard.py   (stdlib unittest, no dependencies)
"""
import importlib.util
import ipaddress
import socket
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("dr_plugin_api", ROOT / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(api)


class TestBlockedIPs(unittest.TestCase):
    def test_private_and_special_ips_blocked(self):
        for addr in ("127.0.0.1", "10.0.0.5", "172.16.1.1", "192.168.1.1",
                     "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1",
                     "255.255.255.255", "::1", "fc00::1", "fe80::1",
                     "::ffff:127.0.0.1", "::ffff:10.0.0.1"):
            with self.subTest(addr=addr):
                self.assertTrue(api._is_blocked_ip(ipaddress.ip_address(addr)), addr)

    def test_public_ips_allowed(self):
        for addr in ("93.184.216.34", "8.8.8.8", "2606:4700::1111"):
            with self.subTest(addr=addr):
                self.assertFalse(api._is_blocked_ip(ipaddress.ip_address(addr)), addr)


class TestValidateURL(unittest.TestCase):
    BLOCKED = [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com/",
        "javascript:alert(1)",
        "data:text/html,hello",
        "http://127.0.0.1/",
        "http://127.0.0.1:8080/admin",
        "http://localhost/",
        "http://10.0.0.5/",
        "http://172.16.1.1/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://0.0.0.0/",
        "http://100.64.0.1/",
        "http://224.0.0.1/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[fc00::1]/",
        "http://user:pass@example.com/",
        "http:///nohost",
        "",
        "not a url",
    ]

    def test_blocked_urls(self):
        for url in self.BLOCKED:
            with self.subTest(url=url):
                with self.assertRaises(api.BlockedURLError):
                    api.validate_outbound_url(url)

    def test_public_host_allowed(self):
        orig = api.socket.getaddrinfo
        api.socket.getaddrinfo = lambda host, port: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
        try:
            api.validate_outbound_url("https://example.com/page?q=1")
        finally:
            api.socket.getaddrinfo = orig

    def test_mixed_dns_records_blocked(self):
        """One public + one private answer for the same host must be refused."""
        orig = api.socket.getaddrinfo
        api.socket.getaddrinfo = lambda host, port: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.9", 0))]
        try:
            with self.assertRaises(api.BlockedURLError):
                api.validate_outbound_url("https://evil.example.com/")
        finally:
            api.socket.getaddrinfo = orig

    def test_unresolvable_host_blocked(self):
        orig = api.socket.getaddrinfo

        def _boom(host, port):
            raise socket.gaierror("nope")
        api.socket.getaddrinfo = _boom
        try:
            with self.assertRaises(api.BlockedURLError):
                api.validate_outbound_url("https://no-such-host.invalid/")
        finally:
            api.socket.getaddrinfo = orig


class TestRedirectHandler(unittest.TestCase):
    def test_redirect_to_private_blocked(self):
        handler = api._SafeRedirectHandler()
        with self.assertRaises(api.BlockedURLError):
            handler.redirect_request(None, None, 302, "Found", {}, "http://127.0.0.1/")

    def test_redirect_to_metadata_blocked(self):
        handler = api._SafeRedirectHandler()
        with self.assertRaises(api.BlockedURLError):
            handler.redirect_request(None, None, 302, "Found", {},
                                     "http://169.254.169.254/latest/meta-data/")


class TestWebExtractBlocked(unittest.TestCase):
    def test_web_extract_returns_blocked_marker(self):
        out = api.web_extract("http://127.0.0.1:9999/")
        self.assertTrue(out.startswith("[Extraction blocked:"), out)

    def test_web_extract_file_scheme(self):
        out = api.web_extract("file:///etc/passwd")
        self.assertTrue(out.startswith("[Extraction blocked:"), out)


class TestFencing(unittest.TestCase):
    def test_fence_wraps_and_strips(self):
        fenced = api._fence_untrusted("hello\u200b\x01world\nline2")
        self.assertTrue(fenced.startswith(api._UNTRUSTED_OPEN))
        self.assertTrue(fenced.endswith(api._UNTRUSTED_CLOSE))
        self.assertNotIn("\u200b", fenced)
        self.assertNotIn("\x01", fenced)
        self.assertIn("helloworld", fenced)


class TestJobId(unittest.TestCase):
    def test_valid_ids_pass(self):
        for jid in ("a1b2c3d4", "task_123", "01a0f522-1169-7ab0", "x" * 64):
            self.assertEqual(api._safe_job_id(jid), jid)

    def test_traversal_rejected(self):
        for jid in ("../../etc/passwd", "a/b", "..", "", "x" * 65, "a b"):
            with self.subTest(jid=jid):
                with self.assertRaises(api.HTTPException):
                    api._safe_job_id(jid)


if __name__ == "__main__":
    unittest.main(verbosity=2)
