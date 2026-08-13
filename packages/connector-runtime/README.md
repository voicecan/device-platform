# @voicecan/connector-runtime

Durable Node.js primitives for independent applications consuming VoiceCan Device Platform events and recordings. It includes Webhook hosting, idempotent target dispatch, SQLite Inbox/tombstone/outbox/metrics infrastructure, and authorization-aware Recording reconciliation.

```bash
npm install @voicecan/connector-runtime
```

The runtime does not define application jobs, Transcript, ASR, Summary, or LLM behavior; those remain owned by the consuming application.
