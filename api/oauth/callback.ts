import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = req.query.code as string | undefined;

  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    // 1. Exchange code for tokens with Google
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.YOUTUBE_CLIENT_ID!,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET!,
        redirect_uri: 'https://youtube-oauth-bridge.vercel.app/api/oauth/callback',
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error('Google token error:', tokenData);
      return res.status(500).send('Failed to exchange OAuth code.');
    }

    // 2. Forward tokens to Famous / DatabasePad
    const forwardRes = await fetch(
      'https://fdrzngyzmfuwnijrmbwp.databasepad.com/functions/v1/youtube-connect',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.FAMOUS_GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          scope: tokenData.scope,
          token_type: tokenData.token_type,
        }),
      }
    );

    if (!forwardRes.ok) {
      const text = await forwardRes.text();
      console.error('Backend forward failed:', text);
      return res.status(500).send('Connected to Google, but backend failed.');
    }

    // 3. Success UI
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <html>
        <body style="font-family: system-ui; text-align: center; margin-top: 40px;">
          <h2>✅ YouTube connected successfully</h2>
          <p>You can close this window and return to the app.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('OAuth bridge error:', err);
    res.status(500).send('Unexpected OAuth error.');
  }
}
