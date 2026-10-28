# Delphi Nodes (Android)

Two things:
1. **Phone node** (in the app): runs your card's node in the background, even with the screen off, and keeps its card
   and widget green. Same work and reports as delphi.site/node, so the attestor credits it the same way.
2. **Home-screen widgets**: each one shows a Genesis Node card as the Delphi oracle silhouette in its live status color.

## Phone node
- **Link once:** the app makes its own signing key (stored only in the app). "Link your wallet" opens
  delphi.site/node/link with that key's address; your wallet signs one approval for one staked card, valid 7 days (the
  attestor's maximum). The site hands it back via `delphinodes://link?c=…` or a code to paste. The key can only sign that
  card's node reports until the approval expires; it holds nothing.
- **Work:** each 10-minute batch is anchored to the latest side-chain block; `seed = keccak(blockHash, tokenId, wallet)[:4]`
  builds the 512×512 Freivalds matrices (result hash recomputed by the attestor), then checks run until the batch ends.
  Batches go to `/api/node-results`, heartbeats every minute to `/api/cards/<id>/live`.
- **Runs as a foreground service** (notification with Stop, partial wake lock). Pauses below 30 % battery unless charging.
  Stops when the approval is about to expire; link again to renew.
- `nodecore/` is the pure-Kotlin core (no Android APIs). Its tests check it against vectors made by delphi.site's own
  TypeScript and viem (`src/test/resources/vectors.json`): mulberry32, anchor seed, result hashes for n = 64/512/1024,
  check outcomes (honest and planted fault), byte-identical signatures, message formats, approval checks. The attestor's
  Python gives the same seed and hashes for those vectors.

| color | meaning |
|---|---|
| green | staked and credited in the last hour |
| red | not running, or not staked (dark red: slashed) |
| yellow | being slashed (appeal window open) |
| gray | cooling down; "No signal" if the phone couldn't refresh for over an hour |

Status comes from `https://www.delphi.site/api/cards/<id>/status`, the same source as the website's `/card/<id>` page.
Widgets refresh about once a minute while the screen is on (and every 15 minutes as a backstop); tapping one opens the card's page.

## Get it
GitHub Actions (`.github/workflows/android.yml`) runs the core tests, then builds every change to `android/` on `main` and uploads `delphi-nodes.apk` to the
**android-latest** release. On your phone: open the release, download the APK, install it (Android asks you to allow
installs from your browser once). New builds install over old ones.

Then: long-press the home screen → Widgets → Delphi Nodes → drag "Delphi Node" out → enter the card number.

## Notes
- No Android Studio needed; CI uses JDK 17 + Gradle 8.11.1, AGP 8.7.3, Kotlin 2.0.21, WorkManager 2.10.0. minSdk 26.
- Signing: this repo is public, so no key is committed. The first CI build creates one and keeps it in the repo's Actions
  cache (pull-request builds never restore it: they run the tests and a debug-signed build only, and never publish). Every later build reuses
  it, so updates install over each other. GitHub drops caches unused for 7 days; if that happens the next build makes a
  new key and the app must be uninstalled once before the new build installs. For a Play Store release, move the key
  into an Actions secret.
