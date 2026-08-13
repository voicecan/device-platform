# Signed events

Verify `VoiceCan-Signature: v1=<hex>` over the exact bytes of `{timestamp}.{delivery_id}.{raw_body}` with HMAC-SHA256. Also verify `VoiceCan-Secret-Id`, a five-minute timestamp tolerance, and delivery/event ID deduplication before processing.

Delivery is at-least-once. Acknowledge only after durable idempotency state is recorded. `file.synced` contains metadata, not audio or an anonymous download link; fetch content with a scoped Group API Token. Device transfer cancels pending old-group deliveries and does not automatically replay historical events to the new group.

