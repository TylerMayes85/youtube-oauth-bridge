import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID!,
    redirect_uri: 'https://youtube-oauth-bridge.vercel.app/api/oauth/callback',
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
    ].join(' '),
  });

  const googleAuthUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  res.redirect(googleAuthUrl);
}
