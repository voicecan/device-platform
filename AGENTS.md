# AGENTS.md — Device Platform

This is the public source repository for the independent VoiceCan device developer platform. It must not import, call, or share databases with `main-service-dev`.

- Runtime: Node.js `>=24.7 <25`, TypeScript strict, npm workspaces.
- Run migrations explicitly with `npm run migrate`; the server must never migrate on startup.
- Device protocol source, schemas, fixtures, fuzz corpora, Cargo files, and raw commands belong only in the separate private `device-core` repository. Never commit them here.
- Consume only the pinned, reviewed `@voicecan/device-core` release artifact under `vendor/`; verify its lock and runtime conformance before build/release.
- Use `node:sqlite` only in the database worker while the server is running.
- Recording content must be streamed; never buffer a complete recording in memory.
- File authorization is always derived through `recording_files.device_id -> devices.group_id`.
- IDs outside the caller's group return the same 404 as missing resources.
- Do not add ASR, LLM, transcript, summary, or VoiceCan cloud dependencies to the server.

Commands:

```bash
npm install
npm run build
npm test
npm run migrate
npm run dev
```
