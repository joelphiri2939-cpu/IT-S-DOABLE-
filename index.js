// IT'S DOABLE! TALENT — R2 Media API
//
// Sits in front of Cloudflare R2. The PWA never talks to R2 directly with
// credentials — it asks this service for a short-lived presigned upload
// URL (proving who it is with its Firebase ID token), uploads the file
// straight to R2 with that URL, then stores the resulting key/URL in
// Firestore itself, exactly like the old Firebase Storage flow.
//
// Deploy this as a second Render service (or a second route group on your
// existing MoneyUnify/SMS proxy — either works, they're independent).

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const {
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE_URL,
  FIREBASE_PROJECT_ID,
  ALLOWED_ORIGIN,
  PORT = 8787
} = process.env;

for (const [name, val] of Object.entries({
  R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, FIREBASE_PROJECT_ID
})) {
  if (!val) console.warn(`[startup] Warning: env var ${name} is not set.`);
}

// ---------------- R2 client (S3-compatible) ----------------
const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT, // e.g. https://<account-id>.r2.cloudflarestorage.com — from the Cloudflare R2 API token page
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

// ---------------- Firebase ID token verification (no service account needed) ----------------
// Firebase ID tokens are standard RS256 JWTs signed by Google. We verify
// the signature against Google's public JWKS and check issuer/audience —
// no firebase-admin, no service account JSON to store on Render.
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

async function verifyFirebaseToken(idToken) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID
  });
  return payload; // payload.sub is the Firebase UID
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing auth token.' });
    const payload = await verifyFirebaseToken(token);
    req.uid = payload.sub;
    next();
  } catch (err) {
    console.error('Auth verify failed:', err.message);
    res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

// ---------------- Ownership rules ----------------
// Mirrors the old Firebase Storage rules: a user may only write inside
// their own folder. product-files stays private (no publicUrl returned)
// until the Payments phase gates downloads behind a paid-order check.
const OWNED_PREFIXES = [
  { prefix: (uid) => `profiles/${uid}/`, public: true },
  { prefix: (uid) => `covers/${uid}/`, public: true },
  { prefix: (uid) => `product-covers/${uid}/`, public: true },
  { prefix: (uid) => `product-files/${uid}/`, public: false },
  { prefix: (uid) => `archive/${uid}/`, public: false },
  { prefix: (uid) => `testimonial-photos/${uid}/`, public: true },
  { prefix: (uid) => `community-value/${uid}/`, public: true }
];

function resolveOwnedPrefix(uid, key) {
  return OWNED_PREFIXES.find((p) => key.startsWith(p.prefix(uid)));
}

const MAX_SIZES = {
  'profiles/': 15 * 1024 * 1024,
  'covers/': 15 * 1024 * 1024,
  'product-covers/': 15 * 1024 * 1024,
  'product-files/': 50 * 1024 * 1024,
  'archive/': 60 * 1024 * 1024,
  'testimonial-photos/': 10 * 1024 * 1024,
  'community-value/': 60 * 1024 * 1024
};
function maxSizeFor(key) {
  const hit = Object.keys(MAX_SIZES).find((p) => key.startsWith(p));
  return hit ? MAX_SIZES[hit] : 15 * 1024 * 1024;
}

// ---------------- App ----------------
const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map((s) => s.trim()) : true }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/r2/presign-upload', requireAuth, async (req, res) => {
  try {
    const { key, contentType, sizeBytes } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing key.' });

    const match = resolveOwnedPrefix(req.uid, key);
    if (!match) return res.status(403).json({ error: 'You can only upload to your own folder.' });

    const limit = maxSizeFor(key);
    if (sizeBytes && Number(sizeBytes) > limit) {
      return res.status(413).json({ error: `File is too large. Limit is ${Math.round(limit / (1024 * 1024))}MB.` });
    }

    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType || 'application/octet-stream'
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
    const publicUrl = match.public && R2_PUBLIC_BASE_URL ? `${R2_PUBLIC_BASE_URL}/${key}` : null;

    res.json({ uploadUrl, publicUrl, key });
  } catch (err) {
    console.error('presign-upload failed:', err);
    res.status(500).json({ error: 'Could not create an upload link. Please try again.' });
  }
});

app.post('/api/r2/presign-download', requireAuth, async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing key.' });

    const match = resolveOwnedPrefix(req.uid, key);
    if (!match) return res.status(403).json({ error: 'You can only view your own files.' });

    const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    res.json({ downloadUrl });
  } catch (err) {
    console.error('presign-download failed:', err);
    res.status(500).json({ error: 'Could not open that file. Please try again.' });
  }
});

app.post('/api/r2/delete', requireAuth, async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing key.' });

    const match = resolveOwnedPrefix(req.uid, key);
    if (!match) return res.status(403).json({ error: 'You can only delete your own files.' });

    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    res.json({ ok: true });
  } catch (err) {
    console.error('delete failed:', err);
    res.status(500).json({ error: 'Could not delete that file. Please try again.' });
  }
});

app.listen(PORT, () => console.log(`R2 media API listening on port ${PORT}`));
