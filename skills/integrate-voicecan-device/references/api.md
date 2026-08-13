# Client API boundaries

Use `/api/v1`. Human UI uses a Secure, HttpOnly, SameSite session cookie plus CSRF token. Automation uses a distinct Group API Token with explicit `devices:read`, `files:read`, `events:read`, and optional `sync:trigger` scopes.

File access must always join `recording_files.device_id` to the Device's current `group_id`; never accept group or storage locator from a caller. Missing and unauthorized objects both return 404. Use cursor pagination and honor 429 `Retry-After`. Use an `Idempotency-Key` for sync commands.

