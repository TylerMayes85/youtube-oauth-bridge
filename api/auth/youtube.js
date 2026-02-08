/**
 * ⚠️ OAUTH CONTRACT LOCKED ⚠️
 *
 * - Always redirect back to frontend
 * - Never render HTML
 * - Never expose tokens
 */

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('[ENV CHECK]', {
  googleClientId: !!GOOGLE_CLIENT_ID,
  googleClientSecret: !!GOOGLE_CLIENT_SECRET,
  supabaseUrl: !!SUPABASE_URL,
  supabaseServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
});

const FALLBACK_REDIRECT_URI =
  process.env.DEFAULT_REDIRECT_URI ||
  'https://insights-growth-trends.deploypad.app/oauth/callback';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_CHANNEL_URL =
  'https://www.googleapis.com/youtube/v3/channels';

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
].join(' ');

// ---------------- helpers ----------------

function encodeState(redirectUri, csrfToken) {
  return Buffer.from(
    JSON.stringify({ redirect_uri: redirectUri, csrf: csrfToken })
  ).toString('base64url');
}

function decodeState(state) {
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function generateState() {
  return Math.random().toString(36).slice(2);
}

function getHandlerUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/auth/youtube`;
}

function getCookieValue(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[2]) : null;
}

function redirectWithError(res, redirectUri, code, description) {
  res.setHeader('Set-Cookie', [
    'oauth_redirect_uri=; Path=/; Max-Age=0',
    'oauth_state=; Path=/; Max-Age=0',
  ]);

  const params = new URLSearchParams({
    error: code,
    error_description: description,
  });

  res.redirect(302, `${redirectUri}?${params}`);
}

// ---------------- main ----------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const { code, state, error, redirect_uri, scope } = req.query;

  if (error) {
    const decoded = decodeState(state);
    const target =
      decoded?.redirect_uri || redirect_uri || FALLBACK_REDIRECT_URI;

    return redirectWithError(res, target, error, 'OAuth cancelled');
  }

  // -------- CALLBACK --------
  if (code) {
    const decoded = decodeState(state);
    const cookieRedirect = getCookieValue(req, 'oauth_redirect_uri');
    const appRedirect =
      decoded?.redirect_uri || cookieRedirect || FALLBACK_REDIRECT_URI;

    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: getHandlerUrl(req),
        }),
      });

      if (!tokenRes.ok)
        return redirectWithError(
          res,
          appRedirect,
          'token_exchange_failed',
          'Token exchange failed'
        );

      const tokenData = await tokenRes.json();
      const { access_token, refresh_token, expires_in } = tokenData;

      if (!refresh_token) {
        console.error('[OAUTH] Missing refresh token');
        return redirectWithError(
          res,
          appRedirect,
          'missing_refresh_token',
          'Re-consent required'
        );
      }

      const channelRes = await fetch(
        `${YOUTUBE_CHANNEL_URL}?part=snippet&mine=true`,
        {
          headers: { Authorization: `Bearer ${access_token}` },
        }
      );

      if (!channelRes.ok)
        return redirectWithError(
          res,
          appRedirect,
          'channel_fetch_failed',
          'Failed to fetch channel'
        );

      const channelData = await channelRes.json();
      const channel = channelData.items?.[0];

      if (!channel)
        return redirectWithError(
          res,
          appRedirect,
          'no_channel',
          'No channel found'
        );

      // -------- STORE TOKENS --------
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
        throw new Error('Supabase env vars missing');

      const insertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/channel_tokens`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            channel_id: channel.id,
            channel_title: channel.snippet.title,
            channel_thumbnail:
              channel.snippet.thumbnails?.default?.url || '',
            access_token,
            refresh_token,
            token_expires_at: new Date(
              Date.now() + expires_in * 1000
            ).toISOString(),
          }),
        }
      );

      if (!insertRes.ok) {
        const text = await insertRes.text();
        throw new Error(`Supabase insert failed: ${text}`);
      }

      const params = new URLSearchParams({
        success: 'true',
        channel_id: channel.id,
        channel_title: channel.snippet.title,
        channel_thumbnail:
          channel.snippet.thumbnails?.default?.url || '',
      });

      return res.redirect(302, `${appRedirect}?${params}`);
    } catch (err) {
      console.error('[OAUTH FATAL]', err);
      return redirectWithError(
        res,
        appRedirect,
        'server_error',
        'OAuth server error'
      );
    }
  }

  // -------- INIT --------
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET)
    return res.status(500).json({ error: 'OAuth not configured' });

  const appRedirect = redirect_uri || FALLBACK_REDIRECT_URI;
  const csrf = generateState();
  const encodedState = encodeState(appRedirect, csrf);

  res.setHeader('Set-Cookie', [
    `oauth_redirect_uri=${encodeURIComponent(
      appRedirect
    )}; Path=/; Max-Age=600; Secure; SameSite=Lax`,
    `oauth_state=${csrf}; Path=/; Max-Age=600; Secure; SameSite=Lax`,
  ]);

  const authParams = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getHandlerUrl(req),
    response_type: 'code',
    scope: scope || DEFAULT_SCOPES,
    state: encodedState,
    access_type: 'offline',
    prompt: 'consent',
  });

  res.redirect(302, `${GOOGLE_AUTH_URL}?${authParams}`);
}
