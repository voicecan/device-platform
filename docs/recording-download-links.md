# Recording Download Grants

Open Platform APIs never carry recording bytes. A consumer with `recordings:download_link:create` creates a short-lived bearer capability:

```http
POST /api/v1/recordings/file_xxx/download-links
Authorization: Bearer vcd_app_...
Idempotency-Key: stable-request-id
Content-Type: application/json

{"purpose":"download","ttl_seconds":300,"reason":"Reviewed export"}
```

The result contains a one-use URL under `/recording-download/v1/<opaque-token>`. The database stores only its peppered hash and the grant's key version; the URL token is deterministically derived from a retained server key so an idempotent retry can return the same capability without storing plaintext.

Consumption checks token state, Application and originating credential/OAuth state, recording lifecycle, current Device Group and ownership epoch, policy, and finally atomically consumes the request budget. The response pins content type, filename, length, SHA-256, and `range_supported`; S3 handles Range and short connection retries after the one-time redirect is consumed.

For `s3_direct`, the gateway validates current authorization and returns a `303` to a 1–45 second presigned GET URL, bounded by the remaining Grant lifetime. The Device Server does not carry recording bytes in this mode.

For filesystem/server-relay storage, `gateway` mode streams the immutable object only from the dedicated temporary URL. If the deployment requires that no Device Server process ever carries recording bytes, set:

```text
VOICECAN_DOWNLOAD_DELIVERY_MODE=external_object_only
VOICECAN_STORAGE_DRIVER=s3_direct
```

`external_object_only` rejects link creation for local objects. Full temporary URLs are excluded from request logging, audit, Webhook payloads, and MCP Resources.

Query state through `GET /api/v1/recording-download-grants/{id}` and revoke through `POST /api/v1/recording-download-grants/{id}/revoke`. If the presigned object URL expires, create a new Grant with a new idempotency key. `VOICECAN_DEPLOYMENT_PROFILE=production` fails closed unless both S3 direct storage and external-only delivery are configured.
