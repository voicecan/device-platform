# Elio Admin design

Scope: Devices and Users pages in the independent Elio preview. Preserve their resource ownership, forms, tables, operation handlers, permissions, confirmations and pagination.

Reference: `/Users/elio/Desktop/app/awesome-design-md/design-md/linear.app/DESIGN.md`. The requested `/Users/elio/Desktop/app/admin-web/DESIGN.md` and an existing Platform root DESIGN.md were not present when inspected.

Retain the original warm white canvas (#f7f6f2), white panels, neutral text (#272622), warm hairline borders (#e3e0d9), and teal accent (#466873), as explicitly requested by the user. Use Linear only as a reference for compact typography, spacing, and control hierarchy. Keep a 4px spacing scale, system sans with Chinese fallbacks, 24px page titles, 14px body text, 8px control radii and 12px panel radii. Use surface hierarchy instead of gradients or decorative shadows. Secondary controls remain quiet; destructive actions retain explicit labels and confirmations.

Connection semantics: binding is ownership/setup, server online is the current WebSocket connection, Bluetooth is the current browser maintenance session, Wi-Fi is an observed device snapshot. Missing readings remain unknown. Show full last-online time, timestamp page checks, and disclose failed refreshes. Pending recording counts are distinct from active transfers. Never expose credentials or claim a real-device connection based on a mock.

## Platform onboarding and AI connections
Use the same warm-white/teal tokens across every main route. Main navigation: overview, devices, recordings, AI tools; administrative controls are secondary. Page title 24px, section title 18–22px, body14px, helper12–13px; 4px spacing rhythm, 8px controls, 12px surfaces. One primary action per section. Main path: add device, synchronize recording, connect chosen AI tool. Device addition stays a two-step dialog. Recording tables use human-readable metadata, server pagination and mobile stacked rows. Device controls/firmware remain in explicit settings disclosure. Never call a generated configuration a verified client connection. Local stdio instructions cannot be reused on remote computers; remote OAuth setup stays distinct. Audio read/download scope is opt-in, scoped to a device group and separate from metadata credentials. Demo applications live only under an optional developer disclosure.
