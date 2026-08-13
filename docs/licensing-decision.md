# Licensing decision

On 2026-08-13, the copyright owner approved Apache License 2.0 for the public
Voicecan Device Platform distribution, including the reviewed compiled Device
Core Object form shipped in `@voicecan/device-platform`. The repository and npm
distribution carry `LICENSE` and `NOTICE`; the npm package also carries a
direct-dependency license report.

The architecture requires an explicit decision for each distribution surface:

| Surface | Proposed direction | Required approval/evidence |
| --- | --- | --- |
| Public SDK wrappers, Connector runtime, UI and demos | Apache-2.0 | Approved |
| Device Server source/image | Apache-2.0 | Approved |
| Reviewed compiled Core JS/WASM artifact | Apache-2.0 as part of the Platform distribution; no protocol source or private fixtures | Approved |
| Documentation and examples | Apache-2.0 | Approved |

Future distribution surfaces must retain `LICENSE`/`NOTICE`, package metadata,
dependency-license reporting, and applicable third-party notices. Security
signing and SBOMs do not replace these obligations.
