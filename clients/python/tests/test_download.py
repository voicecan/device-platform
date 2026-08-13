from __future__ import annotations

import hashlib
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import httpx

from voicecan_device import DeviceServer, VoicecanApiError


class DownloadTests(unittest.TestCase):
    def client(self, content: bytes, sha256: str) -> DeviceServer:
        def api(request: httpx.Request) -> httpx.Response:
            return httpx.Response(201, request=request, json={"success": True, "code": "", "message": "success", "request_id": "request-1", "data": {
                "grant_id": "grant-1", "download_url": "https://object.example.test/temporary", "expires_at": "2026-08-07T01:00:00Z",
                "purpose": "download", "content_length": len(content), "content_type": "audio/lc3", "filename": "recording.lc3",
                "sha256": sha256, "range_supported": True, "delivery": "external_temporary_url",
            }})

        client = DeviceServer(base_url="https://device.example.test", application_token="vcd_app_test")
        client._client.close()
        client._client = httpx.Client(base_url="https://device.example.test/api/v1", transport=httpx.MockTransport(api))
        return client

    def test_atomic_verified_download(self) -> None:
        content = b"verified python recording"
        client = self.client(content, hashlib.sha256(content).hexdigest())

        @contextmanager
        def stream(*_args: object, **_kwargs: object):
            yield httpx.Response(200, content=content, request=httpx.Request("GET", "https://object.example.test/temporary"))

        with tempfile.TemporaryDirectory() as directory, patch("voicecan_device.client.httpx.stream", stream):
            destination = Path(directory, "recording.lc3")
            client.download_recording("recording-1", destination, idempotency_key="download-1")
            self.assertEqual(destination.read_bytes(), content)
            with self.assertRaises(FileExistsError):
                client.download_recording("recording-1", destination, idempotency_key="download-2")
            self.assertEqual([path.name for path in Path(directory).iterdir()], ["recording.lc3"])
        client.close()

    def test_checksum_failure_removes_temporary_file(self) -> None:
        content = b"corrupt python recording"
        client = self.client(content, "0" * 64)

        @contextmanager
        def stream(*_args: object, **_kwargs: object):
            yield httpx.Response(200, content=content, request=httpx.Request("GET", "https://object.example.test/temporary"))

        with tempfile.TemporaryDirectory() as directory, patch("voicecan_device.client.httpx.stream", stream):
            with self.assertRaises(VoicecanApiError) as failure:
                client.download_recording("recording-1", Path(directory, "recording.lc3"), idempotency_key="download-1")
            self.assertEqual(failure.exception.code, "DOWNLOAD_SHA256_MISMATCH")
            self.assertEqual(list(Path(directory).iterdir()), [])
        client.close()


if __name__ == "__main__":
    unittest.main()
