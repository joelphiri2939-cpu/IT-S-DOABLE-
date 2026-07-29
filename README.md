# IT'S DOABLE! TALENT — Phase 1: Foundation

Single-page PWA. Everything (HTML/CSS/JS) lives in `index.html` so it's easy
to edit from Termux; the manifest, service worker, and icons are separate
files because the platform requires that.

## What's built in this phase

- **PWA shell** — `manifest.json`, `sw.js` (app-shell caching, network-first
  for navigation so you always get the latest deploy), installable icons.
- **Design system** — CSS variables matching the brand (teal / maroon / gold
  / black / white), Sora for display type, Inter for body text, reusable
  `.btn`, `.field`, `.role-card`, `.status-panel` components.
- **Screens**: Splash → Who Are You (Builder/Community) → Register (Builder
  full form incl. K62.50 subscription intent, or Community — free) → Login
  (email or phone + password, remember me) → Forgot Password → Pending
  (Builder awaiting subscription activation) → Home (minimal real shell,
  shows the signed-in user's actual name/role — no fake data).
- **Firebase wired live**: Auth (email/password, password reset,
  local/session persistence for "remember me"), Firestore writes for
  `users`, `wallets`, `subscriptions` on registration, phone-uniqueness
  check before account creation, role-aware routing guard.
- **Firestore rules** (`firestore.rules`) for the three collections above —
  deny-by-default for everything not yet built.

## Honest boundary of this phase

Builders are created as `isActive:false` / subscription `pending_payment` —
this matches the constitution's rule that "registration is incomplete until
payment is confirmed." The actual mobile money charge isn't wired up yet
(that's Phase 4 — Wallets & Payments), so Builders land on a real "Pending"
screen rather than a fake success state. No mock/demo data anywhere.

## Before you deploy

1. In the Firebase console for project `grok-4`:
   - Enable **Authentication → Email/Password** sign-in provider.
   - Enable **Firestore** (production mode) and paste in `firestore.rules`.
   - Under Authentication → Settings → Authorized domains, add your GitHub
     Pages domain (e.g. `yourname.github.io`) once you deploy.
2. Push this folder to your GitHub Pages repo as-is — no build step needed.
3. Open the deployed URL on your phone and "Add to Home Screen" to test the
   installable PWA.

## Phase 2 — Builder & Community Dashboards (this update)

- **Splash fix**: it was disappearing early because `onAuthStateChanged` can
  resolve almost instantly from a cached session, which raced ahead of the
  old `setTimeout`. Now gated on a `minSplashElapsed` flag so it always
  shows for a real 1.7s regardless of how fast auth resolves. Also added
  the ✍ signature mark as a badge on the splash logo.
- **Builder Dashboard** (`#/builder-dashboard`) — real brand name pulled
  from Firestore, quick-access grid: Profile, Wallet, Community, Market,
  Academy, Archive, Journey, Notifications.
- **Community Dashboard** (`#/community-dashboard`) — real name, quick
  access to Profile, Wallet, Discover Builders, Joined Communities.
- **Discover Builders** (`#/discover`) — live Firestore query for
  `role == 'builder' && isActive == true`, client-side search by brand/
  category/district. Will legitimately show "No active Builders yet" until
  Phase 4 payments make Builders active — that's correct, not a bug.
- **Profile** (`#/profile`) — read-only view of the signed-in user's real
  data. Editing arrives later.
- **Wallet** (`#/wallet`) — real balance read from the `wallets` doc
  created at registration (currently always K0.00, honestly, since no
  money movement is wired up yet).
- **Bottom nav** — persistent 4-tab bar (Home / Community-or-Discover /
  Wallet / Profile), role-aware, shown on all authenticated screens.
- Sections not yet built (Builder Community, Market, Academy, Archive,
  Journey, Notifications, Joined Communities) route to an honest "Coming
  soon" screen explaining what will live there — no fake data or mock
  content anywhere.

## Payments deliberately deferred

At your call, subscription payments are on hold until everything else in
the app works end-to-end. What changed:

- New Builders get `isActive: true` immediately at registration — no more
  hard stop on a "Pending" screen. Their subscription doc is honestly
  labeled `status: 'trial'` (not a fake "paid" state) so it's easy to find
  and flip over once billing exists.
- The dashboard shows **"Trial access — payments coming soon"** instead of
  implying a real subscription is active.
- The old Pending screen and its routing logic are still in the code,
  just dormant — re-enabling the gate later is a one-line change back to
  `isActive: false` at registration, once a real payment step exists to
  flip it to `true`.
- **If you have test Builder accounts from before this change**, they're
  still stuck with `isActive: false` in Firestore — either re-register
  them, or manually flip that field to `true` in the Firestore console.

## Phase 3.5 — Swapped Firebase Storage for Cloudflare R2

Firebase's billing-account requirement for Storage was blocking you, so
media now lives in **Cloudflare R2** instead. Firebase Auth and Firestore
are unchanged — only the file storage layer moved.

**Why not just call R2 directly from the app?** R2's S3-compatible API
needs an access key + secret key to authorize requests, and unlike
Firebase Storage there's no client-side security-rules layer to safely
hand those credentials to a browser. Anyone opening dev tools would see
them and could read/write/delete anything in your bucket. So there's a
small backend in between now: **`/r2-media-api`**.

**How it works:**
1. The PWA asks `r2-media-api` for a presigned upload URL, proving who it
   is with its Firebase ID token (no service account needed — the API
   verifies the token's signature against Google's public keys directly).
2. The API checks the requested file path actually belongs to that user
   (`profiles/{uid}/...`, `product-files/{uid}/...`, etc.) before signing.
3. The PWA uploads the file straight to R2 with that URL — the backend
   never touches the file bytes themselves, just issues permission.
4. Firestore keeps storing the resulting key + public URL exactly like
   before (`coverPath`/`coverUrl`, `filePath` in the private `assets` doc).

**What you need to do:**
1. Create an R2 bucket (e.g. `idt-media`) in the Cloudflare dashboard, and
   an R2 API token with read/write access to it.
2. Deploy `/r2-media-api` as its own Render service (`npm install && npm start`),
   with the environment variables in `r2-media-api/.env.example` filled in.
3. Turn on R2's "Public Development URL" for the bucket (or connect a
   custom domain later) and put that in `R2_PUBLIC_BASE_URL`.
4. In `index.html`, replace `MEDIA_API_BASE`'s placeholder with your
   deployed `r2-media-api` URL.
5. You no longer need to enable Firebase Storage at all — `storage.rules`
   is kept only as a note, not something to paste into the console.

**Storage layout in R2** (same shape as before, just a different backend):
- `profiles/{uid}/...`, `covers/{uid}/...`, `product-covers/{builderId}/{productId}/...` — public read
- `product-files/{builderId}/{productId}/...` — private; paid-download
  gating still arrives in the Payments phase, same as originally planned

## Phase 3 — Media & Storage + Builder Market (combined)

Going forward we're pairing phases so progress moves faster.

**Media & Storage foundation**
- Firebase Storage wired in (`storage.rules` added — push this to the
  Firebase console alongside `firestore.rules`).
- Profile photos: client-side canvas compression (resized + re-encoded as
  JPEG) before upload — keeps Storage costs and Community data usage down.
- Builder cover photo + bio: editable from `#/edit-profile`.
- `#/profile` now shows the real photo (or initials avatar if none set).
- Raw file uploads (audio/video/pdf) use `uploadBytesResumable` with a live
  progress bar, and are size-capped before the upload even starts (5MB
  images, 20MB audio/pdf, 50MB video).

**Builder Market**
- `#/builder-market` — Builders manage their own products (create, list,
  delete) from their dashboard; anyone can view a Builder's Market
  read-only by tapping their card in Discover (`#/builder-market?uid=...`).
- `#/add-product` — title, description, category, price, cover image, and
  an optional digital file (music/video/PDF/book) for digital products.
- **Storage layout**: `profiles/{uid}`, `covers/{uid}` (public read),
  `product-covers/{builderId}/{productId}` (public read), and
  `product-files/{builderId}/{productId}` (owner-only read — this is where
  "books download," music, and video files actually live; see note below).
- Deleting a product cleans up its Storage files too (cover + digital
  asset), not just the Firestore doc.

**On downloads specifically** — the digital file itself is deliberately
*not* publicly readable yet. A Community member buying a song, ebook, or
course needs their `orders` doc checked before they get the file, and that
gating is Payments-phase work (a Cloud Function or your Render proxy, same
pattern as the SMS backend, issuing a short-lived signed URL). Building
open public downloads now would mean re-doing it insecurely later, so the
"Buy & download" button is real but intentionally disabled until then —
not a placeholder, a correctly-sequenced boundary.

Products don't yet have a distinct "Books" category in the schema — they
publish under Builder Market's existing categories (`Books / eBooks` is
now one of the options) rather than a separate books system, matching how
the PRD treats digital products generally.

## Next phases (in order)

4. Payments: subscription billing (K62.50), mobile money commission engine
   (90/10 split), signed-URL gated downloads for digital products
5. Builder Journey (8 Pillars), Builder Community detail, Academy, Archive
6. Notifications, Admin Panel

Say the word when you're ready for the next pair.
