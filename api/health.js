export default function handler(req, res) {
  const hasClientId = !!process.env.GOOGLE_CLIENT_ID;
  const hasClientSecret = !!process.env.GOOGLE_CLIENT_SECRET;
  const hasRedirect = !!process.env.DEFAULT_REDIRECT_URI;

  res.status(200).json({
    status: hasClientId && hasClientSecret ? 'ok' : 'misconfigured',
    oauth: {
      clientId: hasClientId,
      clientSecret: hasClientSecret,
      defaultRedirectUri: hasRedirect,
    },
    runtime: {
      node: process.version,
      env: process.env.VERCEL_ENV || 'unknown',
    },
  });
}
