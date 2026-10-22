# Javier BeatSync P2P

Read `README.md` for behavior and deployment. This is a **static, single-room** GitHub Pages application for `javier.mathnasium.pro`.

## Commands

Use the pinned Bun 1.2.13 runtime, from the repository root:

- `bun install --frozen-lockfile`
- `bun run dev`
- `bun run check`
- `bun run test`
- `bun run build`
- `bun run preview` (serves the exported files at localhost:3000)

The exported site is `apps/client/out/`. The Pages workflow builds and deploys that directory. Do not add application server routes, secret/API-key requirements, or a server dependency to the production site.

## Invariants

- Root URL opens one fixed room. No room/password entry screen.
- Local ICE policy is enforced in `apps/client/src/p2p/localNetwork.ts` and passed through Trystero's `rtcPolyfill`. Both SDP and trickle ICE must remain filtered. Do not add STUN, TURN, public-address fallback, or an internet-audio toggle.
- A browser cannot verify an SSID. Describe this as local reachability, with the documented routed-network/VPN caveat.
- Only the elected host publishes authoritative room state. Every newly joined participant is an admin by default, with Everyone playback controls. Preserve later explicit Everyone/Admins choices and admin changes; permitted listeners request actions through the host. Transport peer IDs bind incoming requests to registered sessions; never trust identity fields supplied inside an envelope.
- Listen to the host's clock. Only the host advances the queue when a track ends.
- Track files use `p2p://` IDs and IndexedDB. Transfer the current/next file on demand, deduplicate requests, and cancel pending work on detach. Never repeatedly broadcast whole playlists' files.
- Stale listener caches must not overwrite an active host's queue. Keep the listener coordinator replica current so it can take over after host departure.
- Preserve the original calibration screen and Start System gesture; do not schedule music before both clock sync and audio unlock.
- The UI source of truth is `mkieffer1107/beatsync` at `0f0312f`, not the older P2P fork. Preserve its dashboard, fonts, Library, Live Queue, player, permissions and timing tools. Do not introduce a new header/banner or redesign those components.
- Keep playlist metadata and audio after clearing the queue. All metadata snapshots must include original audio titles/durations, playlists, permissions, and shuffle state for handover.
- Keep `LICENSE`, bundled font licenses, and upstream credit. Explain the server-only YouTube limitation in its original drawer; never report a successful import without a downloader.

Validate networking/playback changes with unit tests and separate browser sessions using real WebRTC. Distinguish scheduled timing from physical speaker synchronization. Physical devices, router isolation, and mobile-background behavior require a real room test.
