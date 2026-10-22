# Beatsync P2P · Javier

A static, single-room version of [Beatsync](https://github.com/mkieffer1107/beatsync), based on [audiohacking's P2P fork](https://github.com/audiohacking/beatsync-p2p). Uses the frontend from **mkieffer1107/beatsync at `0f0312f`**, including its dark three-column dashboard, original fonts, Live Queue, playlist library, player, permissions, timing tools, QR sharing, chat, and spatial audio. The networking and file storage underneath run in browsers. Intended address: **https://javier.mathnasium.pro**.

## Use it

1. Connect your devices to the same Wi-Fi and open the site.
2. Tap **Start System** on each device.
3. The first browser becomes the host. Use **Upload audio** to select local audio files, then press Play. MP3 is recommended; each file must be under 64 MiB.
4. Leave the host tab open. Other devices receive the current and next track, cache them in IndexedDB, and play against the host's synchronized clock. Share the QR code to open the same site.

There are no accounts, passwords, or room-code entry steps. The original UI displays a single fixed room (`123456`). The first browser hosts the room and starts as its admin. The original **Everyone / Admins** switch and admin promotion controls are retained: permitted devices can add music and control playback, with every action routed through the elected host. Listeners can chat and adjust their own timing. If the host disappears, a remaining browser becomes the host and playback pauses. Press Play on the new host to resume. Tracks cached on another connected device remain available; files that existed only on the departed device must be added again.

Native speakers work best. Bluetooth, background tabs, screen locking, and different speaker hardware can add delay. The timing nudge controls compensate for audible differences. Browser scheduling cannot guarantee identical physical speaker latency.

## What “local network” means

The site itself is public. Audio connections use WebRTC with **no STUN or TURN servers**. Both outgoing and incoming candidates are filtered: only private IPv4, local IPv6, loopback, and `.local` mDNS host candidates are accepted, through both SDP and trickle ICE. Public IPv4/IPv6, reflexive, and relay candidates are rejected. No production option enables internet audio routing.

This is a local-reachability restriction, **not an SSID check or authentication boundary**. Browsers cannot reliably read your Wi-Fi name or prove that someone is physically in the same room. Wired devices, routed private networks, and a VPN that joins the LAN can also connect. A sufficiently modified client is outside this app's trust model. Do not use this as a security control for sensitive audio. No IP-geolocation service is used.

The page and public Nostr discovery relays require internet access. The relays exchange encrypted WebRTC setup messages, not music or chat; app data travels over the peer connection. No backend, database, music storage account, API key, or subscription is required. Relay availability and policy are outside this project's control. The three configured relay endpoints were verified to accept the discovery protocol during implementation; their future availability is not guaranteed. Relay URLs are centralized in `apps/client/src/p2p/config.ts`.

Guest Wi-Fi/client isolation, browser local-network restrictions, firewalls, and disabled WebRTC can prevent connections. A browser may require you to allow local network access. Safari and managed browsers can restrict local ICE candidates; Chrome is the first troubleshooting choice. The page does not request microphone permission.

## Features from your BeatSync frontend

The original components and styles are the base, not a redesigned P2P screen. Inter, Geist and Geist Mono are bundled locally from your existing frontend build; their licenses are included beside the fonts.

| Original feature | Static P2P behavior |
| --- | --- |
| Live Queue, drag reorder, remove, clear | Retained; permitted devices send changes to the browser host. |
| Play/pause, seek, next/previous, shuffle, Now Playing | Retained with the original Web Audio scheduler; the host advances naturally ended tracks. |
| Search downloaded music | Retained from your repo; searches tracks in the queue in the browser. |
| Library, playlists, track selection/order, rename/edit/delete | Retained; room metadata persists in browser storage and is shared with listeners. |
| Default playlist | Any local playlist can be made default and loaded into an empty queue. |
| Everyone/Admins and admin promotion | Retained; the elected host remains an admin. |
| QR sharing, chat, volume, nudge, metronome, low-pass and spatial controls | Retained in their original positions, including Session/Music/Fun mobile tabs. |
| YouTube video/playlist download and refresh | Requires the original downloader server. The original drawer remains, with disabled import controls and a clear explanation. Upload downloaded audio files instead. |
| Server-side playlist storage | Replaced with browser persistence. Keep at least one device containing the needed files connected. |
| Public room discovery and room passwords | Omitted for the requested single room with no password. |
| IP-based location badges | No geolocation lookup is made for this local room. |

The shared playlist editor also includes a small sizing fix: its inherited dialog width limit previously clipped the track list. The original editor layout, typography, and controls are retained.

A GitHub Pages build cannot run the original YouTube downloader, keep files on a server, or capture arbitrary audio from other applications. This implementation does not claim those server features work without a backend.

## Develop and verify

Use Bun **1.2.13** (pinned in `package.json`), matching the neighboring Mathnasium Pages projects.

```sh
bun install --frozen-lockfile
bun run dev
```

For the same static files GitHub Pages will serve:

```sh
bun run check
bun run test
bun run build
bun run preview
```

Open `http://localhost:3000`. Production output is `apps/client/out/`; the preview command only serves those files. There is no application server in the deployment. Localhost is a secure context; ordinary `http://192.168...` phone previews are not, so use the deployed HTTPS site for physical-device testing.

The default build uses the domain root. To build for a GitHub repository URL instead, set `NEXT_PUBLIC_BASE_PATH=/your-repository` for **both** build and fallback generation (the root build command does both).

## GitHub Pages and custom domain

The workflow `.github/workflows/deploy-pages.yml` follows the neighboring Mathnasium projects: Bun install, type checks, tests, static export, Pages artifact upload, and deployment on a push to `main` or manual dispatch.

1. The repository is published at **https://github.com/mathnasiumlakeland/beatsync_p2p**. Future pushes to `main` deploy automatically.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. Set the custom domain to **javier.mathnasium.pro**.
4. In your DNS provider, point `javier` with a CNAME to **mathnasiumlakeland.github.io** (not a repository path). Remove any conflicting record for that name. If your DNS already routes this subdomain correctly, keep that setup.
5. Run the deployment workflow and enable **Enforce HTTPS** when GitHub finishes issuing its certificate.

`apps/client/public/CNAME` is copied to `out/CNAME`. The workflow uses `configure-pages`'s `base_path`, so a configured custom domain builds at `/`. If you change Pages from a repository URL to the domain later, rerun the workflow to rebuild with the new path. `.nojekyll` preserves `_next/` assets. Old room links redirect to the one root room.

## Implementation

Trystero is pinned to **0.26.0**, which fixes upstream idle-offer and quick-rejoin failures ([release notes](https://github.com/dmotz/trystero/releases/tag/0.26.0)). The local protocol uses a separate `v3` room namespace so older clients cannot mix incompatible action formats. Audio transfers require approval of the sender, request ID, and declared byte count before receiving their payload. Reload every open tab when updating the site.

- `apps/client/src/p2p/localNetwork.ts`: enforced local ICE policy.
- `apps/client/src/store/p2pConnection.ts`: transport-bound peer identity, host continuity, message authority, and clock routing.
- `apps/client/src/p2p/host/P2PRoomCoordinator.ts`: shared queue, playback load barrier, scheduled actions, and listener replicas.
- `apps/client/src/p2p/audio/transfer.ts`: discover a cached copy, select one sender, deduplicate requests, show progress, validate size, cancel on disconnect, and cache with IndexedDB.
- `apps/client/src/store/global.tsx`: the original Web Audio playback engine; only the host advances the queue automatically.

A fresh host restores its own playable browser cache. Once connected, the active host's queue wins; a richer stale cache cannot restore tracks the host deleted. Audio transfers are limited to requested files, and only current/next files are prefetched. Clearing the queue or removing a row retains its cached file so saved playlists still work. Clearing browser site data removes that browser's audio and saved metadata. Each browser keeps only files it uploaded or received; untransferred files are not replicated automatically. When all peers leave, the next host can restore only its own cache.

## Verification (October 17, 2026)

- Type checks, 52 unit tests, and the production static export pass. Tests cover local ICE filtering, host election, permission enforcement, library persistence/replication, queue clearing, playback ordering, load barriers, and pausing before first playback.
- Separate real Chromium sessions transferred generated audio over host-only WebRTC connections with empty ICE-server lists. Audio stayed silent before Start System.
- The original Library UI created a two-track playlist, marked it default, cleared the live queue without losing the playlist, then loaded its tracks again. Cached tracks and the playlist survived standalone reloads.
- A simulated 60-second listener clock skew calibrated to approximately -59,999.85 ms. After Start System, the listener joined the current track position. A newly permitted listener could start playback and upload audio through the host; admin promotion, downloaded-track search, and chat were also checked.
- Closing the original host elected the remaining browser, retained the three-track queue and two-track default playlist, and allowed playback to resume. A final solo reload restored all three cached files and the playlist with playback paused.
- Desktop at 1440×900 and mobile at 390×844 use the original UI. The mobile document width stayed at 390 pixels; track selection in the playlist editor worked at that size.

These are browser tests on one Mac. Physical phones, speaker latency, the actual Wi-Fi router, and mobile background behavior still need a room test. The site was published on October 22, 2026 at **https://javier.mathnasium.pro**, with a DNS-only CNAME to `mathnasiumlakeland.github.io` and HTTPS enforcement. The latest native-browser verification on this Mac did not establish a peer connection: signaling succeeded, but no usable remote local address was resolved. Treat cross-device playback as unverified until tested on the intended Wi-Fi; the app now reports local connection failures through its existing notifications.

## Credits and license

Original [Beatsync by Freeman Jiang](https://github.com/freeman-jiang/beatsync), [Mathnasium fork](https://github.com/mkieffer1107/beatsync), and [P2P work by audiohacking](https://github.com/audiohacking/beatsync-p2p). See `LICENSE`. Bundled demo music and advertising metadata have been removed from this build.
