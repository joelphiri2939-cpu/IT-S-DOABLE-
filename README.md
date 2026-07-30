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

## Phase 6 — Self-membership bug + rules/app mismatch, fully traced and fixed

**The actual root cause of "insufficient permissions" even after joining,
confirmed by reading the real code (not guessed):**

1. **Self-membership bug (the real trigger).** `populateBuilderMarket`
   resolved the target Builder as `params.get('uid') || currentUid` — so
   any time a Community user landed on `#/builder-market` with no `?uid=`
   (e.g. an unexpected/stale navigation), `targetUid` silently became
   their *own* account instead of failing safely. If they tapped Follow in
   that state, it created a nonsense `memberships/{uid}_{uid}` doc — a
   membership to themselves — while the intended Builder never got a real
   membership row at all. Then visiting that Builder's actual page still
   correctly shows "not following," because it genuinely isn't.
   **Fixed**: target now resolves to `null` (not the viewer's own uid) for
   a Community user with no explicit `?uid=`, the screen shows "Pick a
   Builder from Discover" and stops before any membership logic can run,
   and `joinBuilderCommunity()` itself now throws if asked to follow
   yourself — two independent layers, not just a UI-level check.
2. **A second, separate problem stacked on top**: the `firestore.rules`
   you're running still gates `communityValue` reads behind
   `isMemberOf()`, but the app's Community Value screens (and the new
   cross-Builder "For You" feed from last round) were already built
   assuming **open** reads — the gate you asked me to remove two rounds
   ago. That mismatch means even a *correctly created* membership
   wouldn't have fully fixed things, and — more importantly — the For You
   feed's unfiltered, multi-Builder query is fundamentally incompatible
   with a membership-gated rule: Firestore validates `list` queries
   against the *entire potential result set*, not per returned document,
   so an unfiltered query against a gated collection is denied outright,
   not just filtered down. Re-gating `communityValue` would break the feed
   for everyone, not narrow it. **Fixed**: rules now match what you
   actually asked for and what the app already does — `communityValue`
   (and its `reactions`/`comments` subcollections) are open-read for any
   signed-in user; `memberships` stays as a real Follow/Following
   relationship, just not a content lock.

**On the other diagnosis points you asked me to check:**
- Membership doc ID format (`{builderId}_{memberId}`) and field names
  (`builderId`/`memberId`) — verified correct in the actual code; that
  wasn't the bug here.
- Read vs `get`/`list` split in rules — not needed once the gate's gone;
  there's no longer a difference in what a single-doc read vs. a query
  should allow.
- Unfiltered-query-against-gated-collection — this diagnosis was right,
  and it's resolved by removing the gate (see above), which was already
  the correct direction per your own "should work like Facebook" request.

**What you need to do:** redeploy the corrected `firestore.rules` — this
fix doesn't take effect until you do. Also worth manually checking your
live `memberships` collection in the Firestore console for any doc where
`builderId` equals `memberId` (the self-membership garbage created by the
old bug) and deleting those — they're harmless but pointless clutter.

## Phase 5 — Open feed (Facebook-style), presence, and rules fixes

**Bug fixed: "insufficient permissions" on Follow (and, latent, on
reactions/comments too).** `memberships`, `communityValue/{id}/reactions`,
`communityValue/{id}/comments`, and the `reactionCounts`/`commentCount`
field updates on `communityValue` had never been added to
`firestore.rules` — all silently hitting the default deny-all. Fixed with
proper rules for each:
- `memberships/{builderId_memberId}` — a member can only create/delete
  their own row (doc ID is literally `{builderId}_{memberId}`, enforced in
  the rule).
- `communityValue/{id}/reactions/{uid}` — one reaction doc per user per
  post, doc ID is their own uid.
- `communityValue/{id}/comments/{id}` — anyone can create as themselves;
  delete allowed for the comment's author OR the Builder who owns the post.
- `communityValue/{id}` update — the owning Builder can edit/delete
  normally; anyone else may **only** touch `reactionCounts`/`commentCount`
  (checked via `diff().affectedKeys().hasOnly([...])`), nothing else on
  the post.

**Redeploy `firestore.rules` — nothing above works without it.**

**Media is no longer locked behind Following.** Previously, Community
Value photos/videos/music were hidden entirely unless you'd joined that
Builder's community — this was a client-side gate someone had added, not
something you asked for. Removed. Following is now what it should be:
a genuine "stay updated + show up in my Joined Communities list" action,
not a paywall. (Paid/gated content is a separate, deliberate thing —
`product-files`, still locked until Payments exists to verify purchase.)

**New: the "For You" feed** (Explore -> For You tab, now the default
landing tab). This is the actual fix for "if someone hasn't followed
anyone they should still see different Builders' content" — a real
cross-Builder chronological feed, paginated with a "Load more" button,
each post showing the Builder's name/avatar/online status, inline
Follow button, and the same reactions/comments/share/download already
built. Within each fetched page, posts from Builders you already follow
are bubbled toward the top — **this is a simple recency + follow-affinity
heuristic, not a machine-learning recommender.** Worth being honest about:
it delivers "see more of what you've engaged with" without needing a
recommendation-engine build-out, but it's not personalized in the way a
mature Instagram/TikTok algorithm is. That's a much bigger project for
if/when it's actually needed.

**New: online/offline presence.** A Builder's own device pings
`lastActiveAt` roughly every 90 seconds — only while their tab is actually
visible (paused when backgrounded, via the Page Visibility API) — no
realtime listeners involved. Anyone viewing shows a green dot if that
timestamp is within the last 2 minutes. Deliberately simple:
- **Why not Firebase Realtime Database's built-in presence** (the
  "textbook" way to do this, with automatic offline-detection via
  `onDisconnect`)? It's more accurate (catches crashes/closed tabs
  instantly) but is a second database to wire up. This Firestore-heartbeat
  version is good enough for a presence dot and ships today; RTDB is the
  natural upgrade path if presence accuracy ever actually matters more.
- **Why not a live listener for the dot itself?** At thousands of
  concurrent users, `onSnapshot` on presence data multiplies read costs
  fast. The dot is only as fresh as the last time you loaded that screen —
  fine for "is this person around," not meant to update the instant they
  go offline while you're staring at it.

**Fixed a second, unrelated bug found while in here**: comment-delete
permission in the lightbox was checking a stale global (whichever Builder
Market you'd last visited) instead of the actual post's owner — meant a
Builder could sometimes see (or be denied) a delete button incorrectly
when opening a post from the new cross-Builder feed. Now checks the real
per-post owner.

**On scale (the "50,000+ users" requirement):** the choices above were
made with that in mind —
- No realtime (`onSnapshot`) listeners anywhere in the feed or presence
  system; everything is an explicit, user-initiated `getDocs` fetch.
- The feed is cursor-paginated (`startAfter`), not "load everything."
- Builder profile lookups for the feed are deduplicated and cached
  in-memory per session (`feedBuilderMetaCache`) — a page of 15 posts from
  5 distinct Builders costs 5 reads, not 15.
- Media itself is served straight from R2's public URLs, which sit behind
  Cloudflare's CDN — video/audio playback doesn't hit your origin storage
  repeatedly no matter how many people are watching the same file.
- No new Firestore composite indexes were needed for any of this (checked
  each query) — everything here is single-field, auto-indexed.

## Phase 4.5 — Community Value feed (Builders' media, playable by Community)

Archive is private (owner-only) and product files are payment-gated, so
there was no path for Community to actually play a Builder's video/audio
before this. Fixed by building **Community Value** — the free public feed
tab (first tab, matching the original design doc's tab order) on every
Builder's Market page:

- Builders post photos, videos, audio, or text updates — genuinely public,
  stored under `community-value/{uid}/` in R2 (public prefix, unlike
  Archive or product files).
- Any signed-in Community member (or another Builder) visiting that
  Builder's Market sees these rendered as real inline players — `<video
  controls>`, `<audio controls>`, `<img>` — no gating, no purchase
  required, no presigned-URL round trip needed since it's public content
  served straight from R2.
- Deleting a post removes both the Firestore doc and the R2 file.
- Builder Market now opens on the Updates tab by default, so Community
  lands directly on playable content.

This is distinct from **Archive** (private personal library, owner-only)
and **product files** (for sale, stay private until Payments gates
downloads) — Community Value is the one that's meant to be freely played
by anyone.

## Phase 4 — Auth bug fix + real Archive/Testimonials, honest scope on Live

**Critical fix: registration/login "insufficient permissions" error.**
Root cause: phone-uniqueness checks (at registration) and phone-based
login both queried the `users` collection, which requires `isSignedIn()`
to read — but those queries run *before* the user is authenticated.
Firestore correctly rejected them every time. Fixed with a new, minimal,
publicly-readable `phoneIndex` collection (just phone -> {uid, email},
nothing sensitive) that both flows use instead. `firestore.rules` updated
to match — **redeploy the rules file**, this won't work with the old one.

**Builder Archive** (`#/archive`) — real private media library. Upload
photos, videos, or music (stored in R2 under `archive/{uid}/`, never
public), filter by type, view (opens a short-lived signed URL — even
private files, the owner can still play them), delete. This is the
general-purpose "upload video/image/music" feature, separate from product
uploads.

**Testimonials** — a real Community-side upload feature. On any Builder's
Market (`#/builder-market`), anyone signed in *except* the Builder
themself can leave a text testimonial with an optional photo. Public read,
photos go to `testimonial-photos/{uid}/` (public in R2).

**Live sessions** — added as a tab in Builder Market, but intentionally
**not** built as a working feature yet. Cloudflare R2 is object storage;
it has no live video ingest (RTMP) or playback pipeline. Faking this would
mean a broken "Go Live" button. Real live streaming needs a dedicated
provider — Cloudflare Stream Live, Mux, or similar — each with its own
pricing and setup. Worth a separate conversation before building it,
rather than bolting on something that doesn't actually stream.

**Backend additions** (`r2-media-api`): new `archive/{uid}/` (private) and
`testimonial-photos/{uid}/` (public) prefixes, plus a
`/api/r2/presign-download` endpoint so owners can view their own private
files (Archive) — previously the API could only issue upload/delete URLs.

## Setting up your R2 credentials on Render

Cloudflare gives you exactly 3 values when you create an R2 API token —
put them straight into `r2-media-api`'s environment variables on Render
(Render dashboard -> your service -> Environment), never into any file in
this repo:

- `R2_ENDPOINT` <- the endpoint URL Cloudflare showed you
- `R2_ACCESS_KEY_ID` <- Access Key ID
- `R2_SECRET_ACCESS_KEY` <- Secret Access Key

You'll also set `R2_BUCKET` (the name you gave your bucket) and
`R2_PUBLIC_BASE_URL` (from enabling the bucket's public r2.dev URL, or a
custom domain) yourself — see `r2-media-api/.env.example` for the full
list with explanations.

**Important:** if you've ever pasted real API keys into a chat, doc, or
anywhere outside Render's environment variables, treat them as
compromised and regenerate them from the Cloudflare dashboard. Anyone who
can read that text can read/write/delete your entire R2 bucket.

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
