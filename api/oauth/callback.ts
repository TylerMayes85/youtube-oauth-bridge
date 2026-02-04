import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = req.query.code as string | undefined;

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  // For now, just prove the round-trip worked
  // We will wire this to DatabasePad / Famous next
  return res.status(200).send(`
    OAuth completed successfully.

    Authorization code received:
    ${code}

    You can close this window.
  `);
}
