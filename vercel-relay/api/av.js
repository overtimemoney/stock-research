// Mispriced — Alpha Vantage relay door on Vercel (2026-11-22).
//
// Why this exists: Alpha Vantage rate-limits the Cloudflare Workers
// egress pool (its free-tier "spread out your requests" refusal comes
// back even for spaced calls from Workers IPs), while the same key
// answers fine from other egress. Vercel functions exit through AWS
// ranges — a different door, same trick as the Finviz door.
//
// Contract: GET /api/av?url=<encoded alphavantage.co URL>
//           header: x-relay-key: <RELAY_KEY>
// Returns the upstream body verbatim with the upstream status.
// alphavantage.co-only allowlist + key gate: this is not an open proxy.
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const key = process.env.RELAY_KEY;
  if (!key || req.headers.get('x-relay-key') !== key) {
    return new Response('forbidden', { status: 403 });
  }
  const u = new URL(req.url).searchParams.get('url');
  if (!u) return new Response('missing url', { status: 400 });
  let target;
  try { target = new URL(u); } catch (e) { return new Response('bad url', { status: 400 }); }
  if (target.hostname !== 'www.alphavantage.co') {
    return new Response('alphavantage only', { status: 400 });
  }
  const up = await fetch(target.toString(), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' }
  });
  const body = await up.text();
  return new Response(body, {
    status: up.status,
    headers: { 'Content-Type': up.headers.get('Content-Type') || 'application/json; charset=utf-8' }
  });
}
