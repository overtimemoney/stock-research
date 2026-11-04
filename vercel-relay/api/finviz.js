// Mispriced — Finviz relay door on Vercel (prepped 2026-11-03, NOT yet
// deployed; needs Justin's Vercel account + a RELAY_KEY env var set to
// the same value as the Worker's scan key).
//
// Why this exists: Finviz throttles the Cloudflare Workers egress pool.
// Vercel functions exit through AWS ranges — a different door. The
// Worker calls this only when its direct Finviz fetch is refused.
//
// Contract: GET /api/finviz?url=<encoded finviz.com URL>
//           header: x-relay-key: <RELAY_KEY>
// Returns the upstream body verbatim with the upstream status for
// non-200s, so the Worker's payload validation decides what's usable.
// Finviz-only allowlist + key gate: this is not an open proxy.
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
  if (target.hostname !== 'finviz.com') {
    return new Response('finviz only', { status: 400 });
  }
  const up = await fetch(target.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  const body = await up.text();
  return new Response(body, {
    status: up.status,
    headers: { 'Content-Type': up.headers.get('Content-Type') || 'text/html; charset=utf-8' }
  });
}
