# CS2 Highlights

Turns a full FACEIT match recording (OBS) + the match's `.dem` into one highlight reel. The demo tells us exactly when every kill, clutch, plant and defuse happened. The recording gets cut to those moments, and everything else (freeze time, pauses, dead time) is dropped.

Everything runs locally. Recordings are read in place and never copied or uploaded.

## Run

```bash
npm install
npm run build
npm start
```

Open http://localhost:5174. For development with hot reload, use `npm run dev` (UI on :5173).

Requires FFmpeg on PATH (or `FFMPEG_PATH` / `FFPROBE_PATH`). NVIDIA NVENC is used automatically when available.

## Flow

1. **New match**: pick the recording and the demo (`.dem`, `.dem.zst` or `.dem.gz`).
2. **Player**: pick yourself once. Your SteamID is remembered.
3. **Sync**: auto-sync scans the top-right kill feed for your red-outlined entries and fits them to your kills and deaths in the demo. If confidence is low, pick one kill, pause the preview where it pops into the kill feed, and click *Set sync here*. You can also shift the timing globally or per round.
4. **Highlights**: every round with its moments (kills/multi-kills, clutches, plants/defuses, round-enders, funny deaths, deaths). Toggle, trim, and preview each one.
5. **Export**: pre/post-roll, round title cards, output path. Renders `<recording>_highlights.mp4` next to the recording, with all OBS audio tracks kept.

## CLI

```bash
npm run cli -- players  match.dem.zst
npm run cli -- moments  match.dem.zst --me 7656119...
npm run cli -- inspect  match.dem.zst          # raw event names/fields, for debugging the parser
npm run cli -- run rec.mkv match.dem.zst --me 7656119... --dry
npm run cli -- run rec.mkv match.dem.zst --me 7656119... --sync 51234:612.4
```

## Layout

| Path | What |
| --- | --- |
| `server/demo/parse.ts` | demoparser2 → rounds, kills, bombs, rosters, score |
| `server/demo/moments.ts` | scoring: kill chains, clutch detection, deciders, funny moments |
| `server/sync/killfeed.ts` | FFmpeg crop → raw frames → red-outline counter |
| `server/sync/align.ts` | RANSAC tick→video fit, with per-round refinement for pause jumps |
| `server/edit/plan.ts` | moments → merged clip ranges |
| `server/edit/render.ts` | per-segment encode + title cards + lossless concat |
| `server/index.ts` | Fastify API + local file browser + range streaming for previews |
| `web/src` | React UI |
| `scripts/seed-synthetic.ts` | `npm run seed`: a synthetic match to try the app without a real demo |

## Tests

```bash
npm test
```

## Tuning

The kill-feed region defaults to the top-right 30% × 30% of the frame. If your HUD scale is unusual and auto-sync misses, change `killfeed` in `data/settings.json` (fractions of width/height), or use manual sync.
