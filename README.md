# youtube-oauth-bridge
Minimal OAuth bridge for YouTube

Architecture

OAuth is handled by a separate Vercel project: youtube-oauth-bridge

Frontend NEVER talks to Google directly

Frontend NEVER handles tokens

Entry point

GET https://youtube-oauth-bridge.vercel.app/api/auth/youtube


Required query params

redirect_uri → must be a frontend route (e.g. /oauth/callback)

scope → optional (defaults handled by bridge)

OAuth flow

Frontend redirects browser to bridge

Bridge redirects to Google

Google redirects BACK to bridge

Bridge:

exchanges code server-side

fetches channel info

NEVER renders HTML

ALWAYS redirects to frontend

Frontend /oauth/callback:

stores youtube_connected_channel in localStorage

redirects to /

Success redirect format

/oauth/callback?
  success=true
  &channel_id=...
  &channel_title=...
  &channel_thumbnail=...


Failure redirect format

/oauth/callback?
  error=...
  &error_description=...


Health check

GET /api/health


If health ≠ ok → STOP, fix env vars first.

Environment variables (bridge)

GOOGLE_CLIENT_ID ✅

GOOGLE_CLIENT_SECRET ✅

DEFAULT_REDIRECT_URI (fallback only)

Non-negotiables
❌ No popups
❌ No postMessage
❌ No cookies relied on for redirect
❌ No frontend token handling
❌ No “temporary” OAuth changes

Any change violating this contract is a bug, not an experiment.
