/**
 * Vercel OAuth Bridge for YouTube
 * 
 * Deploy to: youtube-oauth-bridge.vercel.app
 * 
 * This serverless function handles the complete Google OAuth flow:
 * 1. Initiates OAuth by redirecting to Google consent screen
 * 2. Receives callback with authorization code
 * 3. Exchanges code for access token (server-side, never exposed to browser)
 * 4. Fetches YouTube channel info
 * 5. Redirects BACK to the frontend app's /oauth/callback with channel info (no tokens)
 * 
 * CRITICAL: After success, this MUST redirect to the app. Never show a static page.
 * 
 * Required Environment Variables (set in Vercel dashboard):
 * - GOOGLE_CLIENT_ID: Your Google OAuth client ID
 * - GOOGLE_CLIENT_SECRET: Your Google OAuth client secret
 * 
 * Optional Environment Variables:
 * - DEFAULT_REDIRECT_URI: Fallback redirect URI if none provided
 *   (defaults to https://insights-growth-trends.deploypad.app/oauth/callback)
 */



// Configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;

// Hardcoded fallback - the app's callback URL
const FALLBACK_REDIRECT_URI = process.env.DEFAULT_REDIRECT_URI || 
  'https://insights-growth-trends.deploypad.app/oauth/callback';

// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_CHANNEL_URL = 'https://www.googleapis.com/youtube/v3/channels';

// Scopes for YouTube Analytics (read-only)
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
].join(' ');

/**
 * Encode redirect_uri + CSRF token into the state parameter.
 * This is MORE RELIABLE than cookies because state survives the Google round-trip
 * regardless of cookie restrictions (SameSite, third-party blocking, etc.)
 */
function encodeState(redirectUri: string, csrfToken: string): string {
  const payload = JSON.stringify({ redirect_uri: redirectUri, csrf: csrfToken });
  return Buffer.from(payload).toString('base64url');
}

/**
 * Decode state parameter back to redirect_uri + CSRF token
 */
function decodeState(state: string): { redirect_uri: string; csrf: string } | null {
  try {
    const payload = Buffer.from(state, 'base64url').toString('utf-8');
    const parsed = JSON.parse(payload);
    if (parsed.redirect_uri && parsed.csrf) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {

  // CORS headers for preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state, error, redirect_uri, scope } = req.query;

  console.log('[Bridge] Request received:', {
    hasCode: !!code,
    hasState: !!state,
    hasError: !!error,
    hasRedirectUri: !!redirect_uri,
    url: req.url,
  });

  // Handle OAuth errors from Google
  if (error) {
    const decodedState = state ? decodeState(state as string) : null;
    const finalRedirectUri = decodedState?.redirect_uri || redirect_uri as string || FALLBACK_REDIRECT_URI;
    console.log('[Bridge] OAuth error from Google:', error, '→ redirecting to:', finalRedirectUri);
    return redirectWithError(res, finalRedirectUri, error as string, 'OAuth was denied or failed');
  }

  // Step 2: Handle callback from Google (has authorization code)
  if (code) {
    return handleCallback(req, res, code as string, state as string);
  }

  // Step 1: Initiate OAuth flow
  return initiateOAuth(req, res, redirect_uri as string, scope as string, state as string);
}

/**
 * Step 1: Initiate OAuth flow
 * Redirects user to Google consent screen
 */
function initiateOAuth(
  req: VercelRequest,
  res: VercelResponse,
  redirectUri: string,
  scope: string,
  clientState: string
) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ 
      error: 'OAuth not configured. Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.',
      hint: 'Set these in your Vercel project environment variables.'
    });
  }

  // Use provided redirect_uri, or fall back to hardcoded default
  const finalRedirectUri = redirectUri || FALLBACK_REDIRECT_URI;
  
  console.log('[Bridge] Initiating OAuth flow');
  console.log('[Bridge] App callback URI:', finalRedirectUri);

  // Generate CSRF token
  const csrfToken = clientState || generateState();

  // Encode redirect_uri INTO the state parameter
  // This is the KEY FIX: state survives the Google round-trip even if cookies fail
  const encodedState = encodeState(finalRedirectUri, csrfToken);

  // Build this handler's callback URL (Google will redirect back HERE)
  const thisHandlerUrl = getHandlerUrl(req);
  
  console.log('[Bridge] Google callback URL (this handler):', thisHandlerUrl);
  console.log('[Bridge] Encoded state with redirect_uri');

  // Build Google OAuth URL
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: thisHandlerUrl,
    response_type: 'code',
    scope: scope || DEFAULT_SCOPES,
    state: encodedState,
    access_type: 'offline',
    prompt: 'consent',
  });

  const googleAuthUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

  // Also store in cookies as backup (may not work in all browsers)
  res.setHeader('Set-Cookie', [
    `oauth_redirect_uri=${encodeURIComponent(finalRedirectUri)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
    `oauth_state=${csrfToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
  ]);

  console.log('[Bridge] Redirecting to Google consent screen');
  
  // Redirect to Google consent screen
  return res.redirect(302, googleAuthUrl);
}

/**
 * Step 2: Handle callback from Google
 * Exchange code for tokens, fetch channel info, redirect to app
 */
async function handleCallback(
  req: VercelRequest,
  res: VercelResponse,
  code: string,
  state: string
) {
  console.log('[Bridge] Handling Google callback with code');

  // PRIMARY: Decode redirect_uri from state parameter (most reliable)
  const decodedState = state ? decodeState(state) : null;
  
  // FALLBACK: Try cookies
  const cookieRedirectUri = getCookieValue(req, 'oauth_redirect_uri');
  
  // Use state-encoded URI first, then cookie, then hardcoded fallback
  const appCallbackUri = decodedState?.redirect_uri || cookieRedirectUri || FALLBACK_REDIRECT_URI;
  
  console.log('[Bridge] Resolved app callback URI:', appCallbackUri);
  console.log('[Bridge] Source:', decodedState?.redirect_uri ? 'state param' : cookieRedirectUri ? 'cookie' : 'hardcoded fallback');

  try {
    // Exchange authorization code for access token
    const thisHandlerUrl = getHandlerUrl(req);
    
    console.log('[Bridge] Exchanging code for token...');
    
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: thisHandlerUrl,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('[Bridge] Token exchange failed:', errorData);
      return redirectWithError(res, appCallbackUri, 'token_exchange_failed', 'Failed to complete authorization');
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('[Bridge] No access token in response');
      return redirectWithError(res, appCallbackUri, 'no_access_token', 'No access token received');
    }

    console.log('[Bridge] Token obtained, fetching channel info...');

    // Fetch YouTube channel info
    const channelResponse = await fetch(
      `${YOUTUBE_CHANNEL_URL}?part=snippet,statistics&mine=true`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!channelResponse.ok) {
      const errorData = await channelResponse.text();
      console.error('[Bridge] Channel fetch failed:', errorData);
      return redirectWithError(res, appCallbackUri, 'channel_fetch_failed', 'Failed to fetch channel information');
    }

    const channelData = await channelResponse.json();
    const channel = channelData.items?.[0];

    if (!channel) {
      console.error('[Bridge] No channel found in response');
      return redirectWithError(res, appCallbackUri, 'no_channel', 'No YouTube channel found for this account');
    }

    // Extract channel info
    const channelId = channel.id;
    const channelTitle = channel.snippet?.title || 'YouTube Channel';
    const channelThumbnail = channel.snippet?.thumbnails?.default?.url || '';

    console.log('[Bridge] Channel found:', channelTitle, '(', channelId, ')');

    // Clear cookies
    res.setHeader('Set-Cookie', [
      'oauth_redirect_uri=; Path=/; HttpOnly; Max-Age=0',
      'oauth_state=; Path=/; HttpOnly; Max-Age=0',
    ]);

    // Build success redirect URL - ALWAYS redirect, NEVER show static page
    const successParams = new URLSearchParams({
      success: 'true',
      channel_id: channelId,
      channel_title: channelTitle,
      channel_thumbnail: channelThumbnail,
    });

    const finalUrl = `${appCallbackUri}?${successParams.toString()}`;
    
    console.log('[Bridge] SUCCESS! Redirecting to app:', finalUrl);
    
    // CRITICAL: Redirect back to the app with channel info
    return res.redirect(302, finalUrl);

  } catch (error) {
    console.error('[Bridge] OAuth callback error:', error);
    return redirectWithError(res, appCallbackUri, 'server_error', 'An unexpected error occurred');
  }
}

/**
 * Redirect to app with error parameters
 * ALWAYS redirects - never shows a static page
 */
function redirectWithError(
  res: VercelResponse,
  redirectUri: string,
  errorCode: string,
  errorDescription: string
) {
  // Clear cookies on error
  res.setHeader('Set-Cookie', [
    'oauth_redirect_uri=; Path=/; HttpOnly; Max-Age=0',
    'oauth_state=; Path=/; HttpOnly; Max-Age=0',
  ]);

  const params = new URLSearchParams({
    error: errorCode,
    error_description: errorDescription,
  });

  // Always redirect to the app, never show a static page
  const finalUri = redirectUri || FALLBACK_REDIRECT_URI;
  const finalUrl = `${finalUri}?${params.toString()}`;
  
  console.log('[Bridge] Error redirect to:', finalUrl);
  
  return res.redirect(302, finalUrl);
}

/**
 * Get this handler's URL for Google to redirect back to
 */
function getHandlerUrl(req: VercelRequest): string {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}/api/auth/youtube`;
}

/**
 * Parse cookie value from request
 */
function getCookieValue(req: VercelRequest, name: string): string | null {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`(^| )${name}=([^;]+)`));
  if (match) {
    return decodeURIComponent(match[2]);
  }
  return null;
}

/**
 * Generate random state for CSRF protection
 */
function generateState(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}
