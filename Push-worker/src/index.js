// IT'S DOABLE! TALENT — Push Notification Worker
//
// Sole job: take a push subscription + a message, sign it with our VAPID
// private key, and hand it to the browser's push service. The Worker
// never stores subscriptions itself — those live in each user's own
// Firestore doc, written directly by their own client (already covered
// by existing Firestore rules). Whoever is TRIGGERING a notification
// reads the recipient's subscription (readable by any signed-in user,
// same trust level as e.g. lastActiveAt) and calls this Worker to
// actually deliver it. This keeps the Worker stateless and avoids needing
// a Firestore service account here.
//
// Why that's an acceptable trade-off, not a corner cut: a leaked
// subscription object (its endpoint URL + public encryption keys) can't
// actually be used to push anything to that device without our VAPID
// PRIVATE key too, which never leaves this Worker's secrets. Worst case
// of exposure is an opaque, low-value identifier — not an open door.

import { buildPushHTTPRequest } from '@pushforge/builder';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

async function verifyFirebaseToken(idToken, projectId) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId
  });
  return payload; // payload.sub is the Firebase UID
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}

// Best-effort in-memory per-actor rate limit. NOTE: Workers run across
// many isolated instances at Cloudflare's edge, so this counter is NOT
// shared globally — a determined actor spread across regions could
// exceed it. This stops accidental/casual over-triggering (the common
// case); real enforcement at scale needs Cloudflare KV or Durable
// Objects for a properly shared counter. Worth upgrading if abuse
// patterns actually show up here.
const recentSends = new Map();
function isRateLimited(actorUid) {
  const now = Date.now();
  const windowMs = 10000; // 10s
  const maxPerWindow = 5;
  const hits = (recentSends.get(actorUid) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  recentSends.set(actorUid, hits);
  if (recentSends.size > 5000) recentSends.clear(); // crude memory guard for a long-lived isolate
  return hits.length > maxPerWindow;
}

function validSubscription(sub) {
  return sub && typeof sub.endpoint === 'string' && sub.endpoint.startsWith('https://')
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true }, 200, env);
    }

    if (url.pathname === '/vapid-public-key' && request.method === 'GET') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, env);
    }

    if (url.pathname === '/api/push/send' && request.method === 'POST') {
      try {
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return json({ error: 'Missing auth token.' }, 401, env);

        let actorUid;
        try {
          const payload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
          actorUid = payload.sub;
        } catch (err) {
          return json({ error: 'Your session has expired. Please log in again.' }, 401, env);
        }

        if (isRateLimited(actorUid)) {
          return json({ error: 'Too many notifications sent — please slow down.' }, 429, env);
        }

        const body = await request.json().catch(() => null);
        if (!body || !validSubscription(body.subscription)) {
          return json({ error: 'Missing or malformed subscription.' }, 400, env);
        }

        const title = String(body.title || 'IT\u2019S DOABLE! TALENT').slice(0, 100);
        const bodyText = String(body.body || '').slice(0, 200);
        const targetUrl = typeof body.url === 'string' ? body.url.slice(0, 300) : '/';
        const tag = typeof body.tag === 'string' ? body.tag.slice(0, 60) : 'general';

        const privateJWK = JSON.parse(env.VAPID_PRIVATE_KEY_JWK);

        const { endpoint, headers, body: pushBody } = await buildPushHTTPRequest({
          privateJWK,
          subscription: body.subscription,
          message: {
            payload: {
              title,
              body: bodyText,
              icon: '/icons/icon-192.png',
              badge: '/icons/icon-192.png',
              tag,
              data: { url: targetUrl }
            },
            adminContact: env.VAPID_ADMIN_CONTACT || 'mailto:admin@example.com',
            options: { ttl: 3600, urgency: 'normal', topic: tag }
          }
        });

        const pushRes = await fetch(endpoint, { method: 'POST', headers, body: pushBody });

        if (pushRes.status === 404 || pushRes.status === 410) {
          // The push service says this subscription is dead (browser
          // uninstalled, permission revoked, etc.) — tell the caller so
          // they can clear it from the recipient's Firestore doc.
          return json({ ok: false, expired: true }, 200, env);
        }
        if (!pushRes.ok) {
          console.error('Push service rejected the request:', pushRes.status, await pushRes.text().catch(() => ''));
          return json({ error: 'The push service rejected this notification.' }, 502, env);
        }

        return json({ ok: true }, 200, env);
      } catch (err) {
        console.error('push send failed:', err);
        return json({ error: 'Could not send that notification. Please try again.' }, 500, env);
      }
    }

    return json({ error: 'Not found.' }, 404, env);
  }
};
