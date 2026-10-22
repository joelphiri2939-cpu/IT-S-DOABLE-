'use strict';
/**
 * Single source of truth for the Market Square catalog (categories, offerings
 * and which options each category allows). Derived from "Categories of
 * Products and Services" (Mr Adams).
 *
 * The browser app embeds an identical copy so the wizard works instantly;
 * tests/catalog-parity.test.js fails if the two ever drift apart. The server
 * is always the authority: every listing is re-validated against THIS file
 * before it can be paid for.
 *
 * Access kinds
 *   stream  - audio/video played in the app          (priced as 24h/7d/30d passes)
 *   read    - documents read online                  (priced as 24h/7d/30d passes)
 *   view    - galleries / samples / artwork viewed   (priced as one-time, lifetime access)
 */

const PASS_IDS = ['h24', 'd7', 'd30'];
const PASS_SECONDS = { h24: 24 * 3600, d7: 7 * 24 * 3600, d30: 30 * 24 * 3600 };

const CATEGORIES = [
  {
    id: 'music-audio', label: 'Music and Audio', icon: '🎵',
    blurb: 'Tracks, albums, beats, podcasts, audiobooks, voice-overs and more.',
    offerings: ['Music track', 'Album', 'Beat / instrumental', 'Podcast', 'Audiobook', 'Voice-over', 'Jingle', 'Sound effect', 'Spoken-word recording'],
    preview: { modes: ['free', 'paid'], label: 'Play demo' },
    access: { kind: 'stream', label: 'Stream' },
    download: { askByDefault: true },
    order: false, accept: 'audio/*'
  },
  {
    id: 'video-film', label: 'Video and Film', icon: '🎬',
    blurb: 'Short films, documentaries, skits, tutorials, music videos and more.',
    offerings: ['Short film', 'Documentary', 'Skit / comedy', 'Tutorial', 'Music video', 'Dance and performance', 'Animation', 'Poetry', 'Podcast', 'Event recording', 'Educational video'],
    preview: { modes: ['free', 'paid'], label: 'Watch demo' },
    access: { kind: 'stream', label: 'Stream' },
    download: { askByDefault: true },
    order: false, accept: 'video/*'
  },
  {
    id: 'writing-publishing', label: 'Writing and Publishing', icon: '📚',
    blurb: 'Books, articles, poetry, stories, scripts, e-books and workbooks.',
    offerings: ['Book', 'Article', 'Poetry', 'Story', 'Script', 'Essay', 'Newsletter', 'Research publication', 'E-book', 'Workbook'],
    preview: { modes: ['free', 'paid'], label: 'Read sample' },
    access: { kind: 'read', label: 'Read online' },
    download: { askByDefault: true },
    order: false, accept: 'application/pdf'
  },
  {
    id: 'photography', label: 'Photography', icon: '📷',
    blurb: 'Portraits, landscapes, events, product photography and stock images.',
    offerings: ['Portraits', 'Landscapes', 'Event photography', 'Product photography', 'Stock images', 'Photo collection', 'Photo editing'],
    preview: { modes: ['free'], label: 'View preview' },
    access: { kind: 'view', label: 'View gallery' },
    download: { askByDefault: false },
    order: false, accept: 'image/*'
  },
  {
    id: 'graphic-design', label: 'Graphic Design and Digital Art', icon: '🎨',
    blurb: 'Posters, logos, flyers, illustrations and digital paintings.',
    offerings: ['Poster', 'Logo', 'Flyer', 'Illustration', 'Digital painting', 'Social media graphic'],
    preview: { modes: [], label: '' },
    access: { kind: 'view', label: 'View sample' },
    download: { askByDefault: false },
    order: false, accept: 'image/*,application/pdf'
  },
  {
    id: 'fashion-clothing', label: 'Fashion and Clothing', icon: '👗',
    blurb: 'Designed dresses, outfits, tailoring, custom clothing and accessories.',
    offerings: ['Designed dresses', 'Outfits', 'Tailoring', 'Custom clothing', 'Accessories', 'Fashion collection', 'Styling'],
    preview: { modes: [], label: '' },
    access: { kind: 'view', label: 'View photos' },
    download: { askByDefault: false },
    order: false, accept: 'image/*'
  },
  {
    id: 'baking-food', label: 'Baking and Food Products', icon: '🍰',
    blurb: 'Cakes, pastries, bread, snacks, confectionery and recipe products.',
    offerings: ['Cakes', 'Pastries', 'Bread', 'Snacks', 'Confectionery', 'Food decoration', 'Recipe products'],
    preview: { modes: [], label: '' },
    access: { kind: 'view', label: 'View product' },
    download: { askByDefault: false },
    order: true, accept: 'image/*,application/pdf'
  },
  {
    id: 'fine-art-crafts', label: 'Fine Art and Crafts', icon: '🖼️',
    blurb: 'Paintings, sculptures, handmade crafts, jewelry, furniture, pottery and more.',
    offerings: ['Paintings', 'Drawings', 'Sculptures', 'Handmade crafts', 'Bags', 'Jewelry', 'Furniture', 'Home décor', 'Pottery', 'Beadwork', 'Woodwork', 'Decorative art'],
    preview: { modes: [], label: '' },
    access: { kind: 'view', label: 'View artwork' },
    download: { askByDefault: false },
    order: true, accept: 'image/*'
  }
];

const LIMITS = {
  titleMin: 3, titleMax: 80,
  descriptionMax: 1000,
  minPriceZmw: 1,           // any paid option must cost at least this
  maxPriceZmw: 50000,
  maxPreviewFiles: 5,
  maxMainFiles: 12,
  maxFileBytes: { image: 5 * 1024 * 1024, audio: 20 * 1024 * 1024, video: 60 * 1024 * 1024, application: 20 * 1024 * 1024 }
};

const CATALOG = { version: 1, categories: CATEGORIES, limits: LIMITS, passIds: PASS_IDS };

const byId = new Map(CATEGORIES.map((c) => [c.id, c]));
function getCategory(id) { return byId.get(id) || null; }

module.exports = { CATALOG, CATEGORIES, LIMITS, PASS_IDS, PASS_SECONDS, getCategory };
