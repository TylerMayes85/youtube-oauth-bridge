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

    // 2. Fetch YouTube channel info
    const channelRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      }
    );

    const channelData = await channelRes.json();

    if (!channelRes.ok || !channelData.items || channelData.items.length === 0) {
      console.error('Failed to fetch channel:', channelData);
      return res.status(500).send('Failed to fetch YouTube channel.');
    }

    const channel = channelData.items[0];

    // 3. MVP SUCCESS RESPONSE
    // Notify main app + close popup
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <html>
        <body>
          <script>
            try {
              localStorage.setItem('youtube_connected', 'true');
              localStorage.setItem('youtube_channel', JSON.stringify({
                id: ${JSON.stringify(channel.id)},
                title: ${JSON.stringify(channel.snippet.title)},
                thumbnail: ${JSON.stringify(
                  channel.snippet.thumbnails?.medium?.url ||
                  channel.snippet.thumbnails?.default?.url ||
                  ''
                )}
              }));
              window.close();
            } catch (e) {
              document.body.innerText = 'Connected, but could not notify app.';
            }
          </script>
          <p>YouTube connected. You can close this window.</p>
        </body>
      </html>
    `);

  } catch (err) {
    console.error('OAuth bridge error:', err);
    res.status(500).send('Unexpected OAuth error.');
  }
}
