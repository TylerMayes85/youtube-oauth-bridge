/**
 * ⚠️ OAUTH CONTRACT LOCKED ⚠️
 *
 * This file MUST:
 * - Always redirect back to the frontend
 * - Never render HTML
 * - Never expose tokens
 *
 * If OAuth breaks, CHECK /api/health FIRST.
 *
 * See README: "YouTube OAuth Contract"

 
 * Vercel OAuth Bridge for YouTube
 *
 * Deploy to: youtube-oauth-bridge.vercel.app
 *
 * This serverless function handles the complete Google OAuth flow:
 * 1. Redirects to Google consent screen
 * 2. Receives authorization code
 * 3. Exchanges code for access token (server-side)
 * 4. Fetches YouTube channel info
 * 5. Redirects BACK to the app's /oauth/callback (never shows a static page)
 */

// Environment variables
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Fallback redirect (your app)
const FALLBACK_REDIRECT_URI =
  process.env.DEFAULT_REDIRECT_URI ||
  "https://insights-growth-trends.deploypad.app/oauth/callback";

// Google endpoints
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_CHANNEL_URL =
  "https://www.googleapis.com/youtube/v3/channels";

// Scopes
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");

// ---------- helpers ----------

function encodeState(redirectUri, csrfToken) {
  const payload = JSON.stringify({
    redirect_uri: redirectUri,
    csrf: csrfToken,
  });
  return Buffer.from(payload).toString("base64url");
}

function decodeState(state) {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (parsed.redirect_uri && parsed.csrf) return parsed;
    return null;
  } catch {
    return null;
  }
}

function generateState() {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

function getHandlerUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/api/auth/youtube`;
}

function getCookieValue(req, name) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[2]) : null;
}

function redirectWithError(res, redirectUri, code, description) {
  res.setHeader("Set-Cookie", [
    "oauth_redirect_uri=; Path=/; Max-Age=0",
    "oauth_state=; Path=/; Max-Age=0",
  ]);

  const params = new URLSearchParams({
    error: code,
    error_description: description,
  });

  res.redirect(302, `${redirectUri}?${params.toString()}`);
}

// ---------- main handler ----------

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { code, state, error, redirect_uri, scope } = req.query;

  // OAuth error from Google
  if (error) {
    const decoded = state ? decodeState(state) : null;
    const target =
      (decoded && decoded.redirect_uri) ||
      redirect_uri ||
      FALLBACK_REDIRECT_URI;

    redirectWithError(
      res,
      target,
      error,
      "OAuth failed or was cancelled"
    );
    return;
  }

  // ---------- CALLBACK ----------
  if (code) {
    const decoded = state ? decodeState(state) : null;
    const cookieRedirect = getCookieValue(req, "oauth_redirect_uri");
    const appRedirect =
      (decoded && decoded.redirect_uri) ||
      cookieRedirect ||
      FALLBACK_REDIRECT_URI;

    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: getHandlerUrl(req),
        }),
      });

      if (!tokenRes.ok) {
        redirectWithError(
          res,
          appRedirect,
          "token_exchange_failed",
          "Failed to exchange token"
        );
        return;
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;

      const channelRes = await fetch(
        `${YOUTUBE_CHANNEL_URL}?part=snippet,statistics&mine=true`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!channelRes.ok) {
        redirectWithError(
          res,
          appRedirect,
          "channel_fetch_failed",
          "Failed to fetch channel"
        );
        return;
      }

      const channelData = await channelRes.json();
      const channel = channelData.items && channelData.items[0];

      if (!channel) {
        redirectWithError(
          res,
          appRedirect,
          "no_channel",
          "No YouTube channel found"
        );
        return;
      }

      const params = new URLSearchParams({
        success: "true",
        channel_id: channel.id,
        channel_title: channel.snippet.title || "",
        channel_thumbnail:
          channel.snippet.thumbnails?.default?.url || "",
      });

      res.redirect(302, `${appRedirect}?${params.toString()}`);
      return;
    } catch (err) {
      redirectWithError(
        res,
        appRedirect,
        "server_error",
        "Unexpected server error"
      );
      return;
    }
  }

  // ---------- INITIATE ----------
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    res.status(500).json({
      error: "OAuth not configured",
    });
    return;
  }

  const appRedirect = redirect_uri || FALLBACK_REDIRECT_URI;
  const csrf = generateState();
  const encodedState = encodeState(appRedirect, csrf);

  res.setHeader("Set-Cookie", [
    `oauth_redirect_uri=${encodeURIComponent(
      appRedirect
    )}; Path=/; Max-Age=600; Secure; SameSite=Lax`,
    `oauth_state=${csrf}; Path=/; Max-Age=600; Secure; SameSite=Lax`,
  ]);

  const authParams = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getHandlerUrl(req),
    response_type: "code",
    scope: scope || DEFAULT_SCOPES,
    state: encodedState,
    access_type: "offline",
    prompt: "consent",
  });

  res.redirect(302, `${GOOGLE_AUTH_URL}?${authParams.toString()}`);
}
