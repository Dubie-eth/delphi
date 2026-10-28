# Delphi Nodes (Android)

Home-screen widgets: each one shows a Genesis Node card as the Delphi oracle silhouette in its live status color.

| color | meaning |
|---|---|
| green | staked and credited in the last hour |
| red | not running, or not staked (dark red: slashed) |
| yellow | being slashed (appeal window open) |
| gray | cooling down; "No signal" if the phone couldn't refresh for over an hour |

Status comes from `https://www.delphi.site/api/cards/<id>/status`, the same source as the website's `/card/<id>` page.
Widgets refresh about every 15 minutes (Android's minimum for background work); tapping one opens the card's page.

## Get it
GitHub Actions (`.github/workflows/android.yml`) builds every change to `android/` on `main` and uploads `delphi-nodes.apk` to the
**android-latest** release. On your phone: open the release, download the APK, install it (Android asks you to allow
installs from your browser once). New builds install over old ones.

Then: long-press the home screen → Widgets → Delphi Nodes → drag "Delphi Node" out → enter the card number.

## Notes
- No Android Studio needed; CI uses JDK 17 + Gradle 8.11.1, AGP 8.7.3, Kotlin 2.0.21, WorkManager 2.10.0. minSdk 26.
- Signing: this repo is public, so no key is committed. The first CI build creates one and keeps it in the repo's Actions
  cache (readable only by this repo's workflows; the build never runs for outside pull requests). Every later build reuses
  it, so updates install over each other. GitHub drops caches unused for 7 days; if that happens the next build makes a
  new key and the app must be uninstalled once before the new build installs. For a Play Store release, move the key
  into an Actions secret.
