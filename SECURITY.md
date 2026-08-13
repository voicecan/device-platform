# Security policy

Do not report device credentials, raw protocol material, exploitable security findings, or private Core details in a public issue.

Use the repository host's private security-advisory channel or the maintainer's established private security contact. Include only the minimum reproduction data and remove Device Tokens, Group API Tokens, webhook secrets, Wi-Fi credentials, recordings, and user data.

The public repository intentionally excludes the protocol source, schemas, Golden Fixtures, fuzz corpora, and raw-command tooling. If any of those appear in a branch, pull request, CI artifact, source map, or release package, treat it as a security incident and stop publication.

Supported security updates currently target the latest Preview version only. Preview releases are not a GA security-support commitment.
