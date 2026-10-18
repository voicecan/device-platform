# Elio local preview

This checkout is the independent `device-platform-elio` development copy.

- Admin: `http://127.0.0.1:8788/admin`
- Runtime state: `data/elio/`, excluded from Git.
- Profile: `elio`, under `data/elio/profiles/`.
- SQLite and local recording storage: `data/elio/server/`.
- The local launcher discards inherited `VOICECAN_*` environment variables and
  explicitly selects this instance's port, database and storage paths.
- Administrator credentials are stored locally in `data/elio/admin-local.json`
  with owner-only permissions. Do not copy them into reports or logs.
- The listener accepts local and LAN connections on port 8788 so a physical
  device can reach its configured Device WebSocket address. Admin remains at
  localhost for a secure browser Bluetooth context. UI preview does not prove
  physical Bluetooth, Wi-Fi or device upload behavior.

Use Node.js 24.19 or a compatible 24.x runtime:

```sh
node data/elio/run.mjs migrate
node data/elio/run.mjs --background serve
```

The running process ID is recorded in `data/elio/server.pid`. Stop only this
process before restarting; do not restart another installation or reuse its data.

## Simplified device connection

The everyday navigation contains Overview, Connect device, Devices, Recording
files and Applications. Organization, diagnostics, transfer and security tools
remain in the expandable management section. Direct links still select and expose
the relevant page.

Browser connection is available immediately. The native app is an explicit
alternative, not a new default. An existing task keeps its original path locked.
Only a single available ownership group is selected automatically; multiple
groups require a choice. Device WebSocket configuration and an optional expected
serial remain available under Advanced settings. Backup guidance remains visible
before starting. A configured device is still waiting until the server confirms
it online. No permission, provisioning or protocol contract was changed.

## BLE command sequencing

Background status reads and Wi-Fi/server configuration share the SDK's command
queue. Stopping a UI live-status poll discards its result after the existing BLE
response drains; it does not abort that wire exchange and hand a late response to
the next configuration command. No protocol frames or private runtime internals
are changed. A failed binding must resume with the same persisted device
credential, rather than replacing it or resetting the device.

## Browser continuation recovery

If the short browser binding cookie expires or belongs to another task, the
Admin retries once after the authenticated, CSRF-protected `reopen` operation.
Group authorization, original origin, native executor checks and the original
task expiry remain enforced. Expired browser tasks display a restart action;
starting a fresh task does not erase the stored device credential or recordings.

## Basic and advanced Applications

Applications opens in Basic quick setup. A configured device group is selected
automatically only when unambiguous. The user selects Codex, Claude Desktop or
another MCP client and prepares a fixed metadata-reader MCP connection in one
action. The backend stores its credential in an owner-only local file; the
generated configuration contains a reference, never the token. Repeated requests
reuse the same connection, including switching client formats. Revocation,
expiry or changed scopes require Advanced management rather than silently
granting fresh access. The existing application control plane remains in Advanced.

Quick setup supports an AI client on the server computer only. It uses the
reviewed local workspace MCP runtime, without npx downloads or profile lookup.
Codex receives a single `codex mcp add` command and a TOML configuration; other
clients receive an MCP JSON entry. Adding to the client is a separate, explicit
step, not a claim that the client is already connected. Audio downloads, device
controls, remote OAuth and Webhooks remain advanced options.

## Automatic recovery copies

Local SQLite deployments with local recovery keys save a verified full recovery
copy before a binding credential or BLE maintenance credential is returned.
Copies live under `<dataDir>/recovery-backups`; the newest three automatic copies
are retained. Unchanged credential sets reuse a verified copy. A first device
online handshake refreshes the copy after credential activation. A failed copy
blocks credential handoff; retry preserves the reserved device credential.
Externally managed keys, PostgreSQL and direct object storage continue to require
operator-managed backups and are explicitly identified in the UI.

Verification checks database integrity and decrypts every device credential using
the copied keyring and pepper. Online SQLite work runs in the database worker.
The status/create endpoints require System Admin; create also requires CSRF.
Manual Save creates a fresh snapshot; Download streams a fresh full archive.
These copies contain recovery keys. They are private local files, not protection
against losing the server computer. An extra offline encrypted copy is optional
in the connection flow but recommended for disaster recovery. Automatic copies
are recovery checkpoints, not a scheduled backup of every later recording.

Existing devices use Bluetooth maintenance without rebinding. The primary network
action writes Wi-Fi, verifies a connected reading, then writes the selected server
address using the existing device credential. Only a server-reported WebSocket
connection is called online. Network rejection preserves the form for correction.


## Developer setup diagnostics and Codex installation

- Connection attempts now display ordered steps from automatic backup through Bluetooth authentication, Wi-Fi configuration and server confirmation. Failure reports retain an allowlisted error code and the failed stage, never arbitrary exception text, Wi-Fi passwords or device credentials.
- Maintenance waits for an actual server-online reading (up to 60 seconds) after the device acknowledges its server settings. A successful write alone is not online evidence.
- The device and MCP pages preflight actual server disk capacity against the configured stop ratio. Storage blockage is shown before users attempt recording upload; setup does not silently lower protection.
- Codex quick setup can now install the existing owner-only connection using the local CLI, without shell interpolation. It verifies the generated runner's initialize/tools-list response, checks for a conflicting `voicecan_elio` entry, and verifies the saved entry. Installation requires loopback, same origin, CSRF and system-admin authorization. Other clients retain manual configuration.
- Current quick MCP scopes are metadata-only. Successful MCP setup does not prove device connectivity, synchronized audio, or access to audio content.
- Real-device acceptance is still blocked: the current public semantic runtime has no WPA option, and the device returned a generic Wi-Fi rejection. Local protocol documentation and the separate App support WPA, but no source for this pinned runtime was found under the requested app folder. No private protocol implementation was copied into this repository and no firmware was changed.
- The five-minute target is not yet accepted. It requires a live device connection, a usable synchronized recording, and a successful MCP response in a timed first-use run.

## Network changes and live Bluetooth state

Automatic server-address candidates are recomputed from current interfaces instead
of retaining the startup LAN address. The maintenance flow reloads these candidates
before configuration; an explicitly chosen server address remains unchanged.
Loopback destinations are rejected before writing Wi-Fi settings.

An idle GATT disconnect now immediately clears the maintenance connection indicator,
disables connected-only actions, and displays reconnection guidance. Transport
writes fail before sending when the GATT connection is already closed. Recovery
credentials are cleared when the disconnected maintenance session is closed.

The current physical test targets the user-selected Home2_5g network. Mac network
details report legacy WPA; the public runtime only offers open/WPA2/WPA3. This is a
compatibility concern, not proof that the supplied password is incorrect. The last
attempt stopped with DEVICE_DISCONNECTED before a usable Wi-Fi outcome. Do not
infer device Wi-Fi success from the Mac connection or Bluetooth authentication.

## Two-step setup before details

The basic connection surface now shows only Bluetooth and Wi-Fi. An offline device
opens this wizard instead of the management workspace. Automatic backup and server
configuration remain enforced; their controls and detailed diagnostics are collapsed.
The current failure stays visible next to the form. Reconnection retains entered
Wi-Fi fields in memory. Only server-confirmed online status opens details; a later
disconnection keeps an already opened workspace available for diagnosis.

New browser binding uses the same two visible steps. Its compact network form keeps
security choices under Advanced, includes server confirmation within the second step,
and retains entered values after failure. Read-only users retain their authorized
inspection view because they cannot perform administrator-only Bluetooth setup.
