from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from threading import Event
import uuid
from pathlib import Path
from typing import Any, Iterator

import httpx


class VoicecanApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, request_id: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id


class DeviceServer:
    def __init__(self, *, base_url: str, application_token: str | None = None, group_token: str | None = None, timeout: float = 30.0, max_retries: int = 3) -> None:
        credential = application_token or group_token
        if not credential:
            raise ValueError("application_token is required")
        self._client = httpx.Client(
            base_url=f"{base_url.rstrip('/')}/api/v1",
            headers={"Authorization": f"Bearer {credential}"},
            timeout=timeout,
        )
        self._max_retries = max_retries

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        for attempt in range(self._max_retries + 1):
            response = self._client.request(method, path, **kwargs)
            if response.status_code != 429 and response.status_code < 500:
                break
            if attempt == self._max_retries:
                break
            retry_after = response.headers.get("Retry-After")
            time.sleep(float(retry_after) if retry_after else 0.1 * (2**attempt))
        payload = response.json()
        if not response.is_success or not payload.get("success"):
            raise VoicecanApiError(response.status_code, payload.get("code", "REQUEST_FAILED"), payload.get("message", "Request failed"), payload.get("request_id"))
        return payload["data"]

    def devices(self) -> list[dict[str, Any]]:
        return self._request("GET", "/devices")

    def device_capabilities(self, device_id: str) -> dict[str, Any]:
        return self._request("GET", f"/devices/{device_id}/capabilities")

    def sync(self, device_id: str, *, idempotency_key: str) -> dict[str, Any]:
        return self._request("POST", f"/devices/{device_id}/sync", headers={"Idempotency-Key": idempotency_key})

    def recording_sync(self, device_id: str) -> dict[str, Any]:
        return self._request("GET", f"/devices/{device_id}/recording-sync")

    def reset_recording_sync(self, device_id: str, *, mode: str = "failed", reason: str = "Python SDK reset recording synchronization") -> dict[str, Any]:
        return self._request("POST", f"/devices/{device_id}/recording-sync/reset", json={"mode": mode, "reason": reason})

    def command(self, device_id: str, *, kind: str, idempotency_key: str) -> dict[str, Any]:
        return self._request("POST", f"/devices/{device_id}/commands", headers={"Idempotency-Key": idempotency_key}, json={"kind": kind})

    def command_status(self, command_id: str) -> dict[str, Any]:
        return self._request("GET", f"/commands/{command_id}")

    def wait_for_command(self, command_id: str, *, timeout: float = 900.0, poll_interval: float = 1.0, cancel_event: Event | None = None) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            if cancel_event and cancel_event.is_set():
                raise VoicecanApiError(499, "COMMAND_WAIT_CANCELED", "Local command wait was canceled")
            command = self.command_status(command_id)
            if command["status"] in {"succeeded", "failed", "expired"}:
                return command
            if time.monotonic() >= deadline:
                raise VoicecanApiError(408, "COMMAND_WAIT_TIMEOUT", "Timed out waiting for command completion")
            if cancel_event:
                cancel_event.wait(poll_interval)
            else:
                time.sleep(poll_interval)

    def files(self, *, status: str | None = None, device_id: str | None = None, attribute: int | None = None, search: str | None = None) -> Iterator[dict[str, Any]]:
        cursor: str | None = None
        while True:
            params = {key: value for key, value in {"status": status, "device_id": device_id, "attribute": attribute, "search": search, "cursor": cursor}.items() if value is not None}
            page = self._request("GET", "/files", params=params)
            yield from page["items"]
            cursor = page["next_cursor"]
            if not cursor:
                break

    def recordings(self, *, status: str | None = None, device_id: str | None = None, attribute: int | None = None, search: str | None = None) -> Iterator[dict[str, Any]]:
        cursor: str | None = None
        while True:
            params = {key: value for key, value in {"status": status, "device_id": device_id, "attribute": attribute, "search": search, "cursor": cursor}.items() if value is not None}
            page = self._request("GET", "/recordings", params=params)
            yield from page["items"]
            cursor = page["next_cursor"]
            if not cursor:
                break

    def recording(self, recording_id: str) -> dict[str, Any]:
        return self._request("GET", f"/recordings/{recording_id}")

    def retry_recording(self, recording_id: str, *, reason: str = "Python SDK retried recording synchronization") -> dict[str, Any]:
        return self._request("POST", f"/recordings/{recording_id}/retry", json={"reason": reason})

    def create_download_link(self, recording_id: str, *, idempotency_key: str, ttl_seconds: int = 300, reason: str = "Python SDK requested recording download") -> dict[str, Any]:
        return self._request("POST", f"/recordings/{recording_id}/download-links", headers={"Idempotency-Key": idempotency_key}, json={"purpose": "download", "ttl_seconds": ttl_seconds, "reason": reason})

    def revoke_download_link(self, grant_id: str, *, reason: str = "Python SDK revoked recording download") -> dict[str, Any]:
        return self._request("POST", f"/recording-download-grants/{grant_id}/revoke", json={"reason": reason})

    def download_grant(self, grant_id: str) -> dict[str, Any]:
        return self._request("GET", f"/recording-download-grants/{grant_id}")

    def download_recording(self, recording_id: str, output_path: str | Path, *, idempotency_key: str) -> None:
        grant = self.create_download_link(recording_id, idempotency_key=idempotency_key)
        path = Path(output_path)
        temporary = path.with_name(f".{path.name}.voicecan-{uuid.uuid4().hex}.tmp")
        digest = hashlib.sha256()
        size = 0
        try:
            with httpx.stream("GET", grant["download_url"], follow_redirects=True, timeout=self._client.timeout) as response:
                if response.status_code in {401, 403, 404, 410}:
                    raise VoicecanApiError(response.status_code, "TEMPORARY_DOWNLOAD_EXPIRED", "Temporary recording URL is invalid or expired; create a new Grant with a new idempotency key")
                response.raise_for_status()
                with temporary.open("xb") as output:
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        digest.update(chunk)
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
            if size != grant["content_length"]:
                raise VoicecanApiError(422, "DOWNLOAD_LENGTH_MISMATCH", f"Expected {grant['content_length']} bytes but received {size}")
            if grant.get("sha256") and digest.hexdigest() != grant["sha256"]:
                raise VoicecanApiError(422, "DOWNLOAD_SHA256_MISMATCH", "Downloaded recording checksum does not match")
            os.link(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def download_to_file(self, file_id: str, output_path: str | Path, *, start: int | None = None) -> None:
        path = Path(output_path)
        headers = {"Range": f"bytes={start}-"} if start is not None else None
        with self._client.stream("GET", f"/files/{file_id}/content", headers=headers) as response:
            response.raise_for_status()
            with path.open("ab" if start is not None else "xb") as output:
                for chunk in response.iter_bytes():
                    output.write(chunk)

    def events(self, *, cursor: str | None = None, event_type: str | None = None, device_id: str | None = None, from_time: str | None = None, to_time: str | None = None, limit: int | None = None) -> dict[str, Any]:
        params = {key: value for key, value in {"cursor": cursor, "event_type": event_type, "device_id": device_id, "from": from_time, "to": to_time, "limit": limit}.items() if value is not None}
        return self._request("GET", "/events", params=params or None)

    def close(self) -> None:
        self._client.close()


def verify_event_signature(*, raw_body: bytes, timestamp: str, delivery_id: str, signature: str, secret: str, tolerance_seconds: int = 300) -> bool:
    try:
        if abs(time.time() - int(timestamp)) > tolerance_seconds:
            return False
    except ValueError:
        return False
    signed = timestamp.encode() + b"." + delivery_id.encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.removeprefix("v1="))


def verify_event_signature_with_secrets(*, raw_body: bytes, timestamp: str, delivery_id: str, signature: str, secrets: list[str], tolerance_seconds: int = 300) -> bool:
    return any(verify_event_signature(raw_body=raw_body, timestamp=timestamp, delivery_id=delivery_id, signature=signature, secret=secret, tolerance_seconds=tolerance_seconds) for secret in secrets)
