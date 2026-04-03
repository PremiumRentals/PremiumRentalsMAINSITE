const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    'https://premiumrentals.homes',
    'https://www.premiumrentals.homes',
    'https://premium-rentals-mainsite.vercel.app',
    'http://localhost:3000'
  ]
}));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Guesty Auth ──
let guestyToken = null;
let guestyTokenExpiry = 0;

async function getGuestyToken() {
  if (guestyToken && Date.now() < guestyTokenExpiry) return guestyToken;
  const res = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'open-api',
      client_id: process.env.GUESTY_CLIENT_ID,
      client_secret: process.env.GUESTY_CLIENT_SECRET
    })
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('Guesty auth failed: ' + JSON.stringify(d));
  guestyToken = d.access_token;
  guestyTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return guestyToken;
}

// ── Cache Layer ──
const cache = {};
const CACHE_TTL = 5 * 60 * 1000;

function getCache(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() > entry.expiry) { delete cache[key]; return null; }
  return entry.data;
}
function setCache(key, data, ttl = CACHE_TTL) {
  cache[key] = { data, expiry: Date.now() + ttl };
}

// ── Helper: get next 30 days date range ──
function getDateRange() {
  const today = new Date();
  const future = new Date();
  future.setDate(future.getDate() + 30);
  const fmt = d => d.toISOString().split('T')[0];
  return { checkIn: fmt(today), checkOut: fmt(future) };
}

// ── Pricing Sync ──
async function syncPricing() {
  console.log('Starting pricing sync...');
  const token = await getGuestyToken();
  const listRes = await fetch('https://open-api.guesty.com/v1/listings?limit=100', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const listData = await listRes.json();
  const listings = (listData.results || []).filter(l => l.active !== false);
  console.log(`Syncing pricing for ${listings.length} listings...`);
  const { checkIn, checkOut } = getDateRange();
  let synced = 0, failed = 0;
  for (const listing of listings) {
    try {
      await new Promise(r => setTimeout(r, 300));
      const avRes = await fetch(
        `https://open-api.guesty.com/v1/availability-pricing/api/v3/listings/${listing._id}?startDate=${checkIn}&endDate=${checkOut}&currency=USD`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const avData = await avRes.json();
      let nightlyRate = null, nextAvailableDate = null;
      if (avData.days && Array.isArray(avData.days)) {
        const firstAvail = avData.days.find(d => d.status === 'available' && d.price);
        if (firstAvail) { nightlyRate = firstAvail.price; nextAvailableDate = firstAvail.date; }
      }
      if (!nightlyRate) nightlyRate = listing.prices?.basePrice || listing.prices?.nightlyRate || null;
      const { error } = await supabase.from('listing_pricing').upsert({
        listing_id: listing._id, nightly_rate: nightlyRate, currency: 'USD',
        next_available_date: nextAvailableDate, updated_at: new Date().toISOString()
      }, { onConflict: 'listing_id' });
      if (error) throw error;
      synced++;
    } catch (e) { console.error(`Failed to sync ${listing._id}:`, e.message); failed++; }
  }
  console.log(`Pricing sync complete: ${synced} synced, ${failed} failed`);
  return { synced, failed, total: listings.length };
}

// ── Route 1: Get all active listings (cached 5 min) ──
app.get('/api/website/listings', async (req, res) => {
  try {
    const cached = getCache('listings_all');
    if (cached) return res.json({ success: true, count: cached.length, listings: cached, cached: true });
    const token = await getGuestyToken();
    const response = await fetch('https://open-api.guesty.com/v1/listings?limit=100', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    const results = (data.results || []).filter(l => l.active !== false);
    const { data: pricing } = await supabase.from('listing_pricing').select('*');
    if (pricing && pricing.length) {
      const priceMap = {};
      pricing.forEach(p => { priceMap[p.listing_id] = p; });
      results.forEach(l => {
        if (priceMap[l._id]) {
          l._realPrice = priceMap[l._id].nightly_rate;
          l._nextAvailable = priceMap[l._id].next_available_date;
        }
      });
    }
    setCache('listings_all', results);
    res.json({ success: true, count: results.length, listings: results, cached: false });
  } catch (e) {
    const stale = cache['listings_all'];
    if (stale) return res.json({ success: true, count: stale.data.length, listings: stale.data, cached: true, stale: true });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 2: Check availability + pricing (cached 2 min) ──
app.get('/api/website/availability/:listingId', async (req, res) => {
  try {
    const { listingId } = req.params;
    const { checkIn, checkOut } = req.query;
    if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut required' });
    const cacheKey = `avail_${listingId}_${checkIn}_${checkOut}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ success: true, ...cached, cached: true });
    const token = await getGuestyToken();
    const response = await fetch(
      `https://open-api.guesty.com/v1/availability-pricing/api/v3/listings/${listingId}?startDate=${checkIn}&endDate=${checkOut}&currency=USD`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    setCache(cacheKey, data, 2 * 60 * 1000);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 3: Get listing calendar via reservations (blocked dates) ──
app.get('/api/website/calendar/:listingId', async (req, res) => {
  try {
    const { listingId } = req.params;
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });

    const cacheKey = `cal_${listingId}_${startDate}_${endDate}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ success: true, blockedDates: cached, cached: true });

    const token = await getGuestyToken();

    const response = await fetch(
      `https://open-api.guesty.com/v1/reservations?listingId=${listingId}&checkIn=${startDate}&checkOut=${endDate}&limit=100&fields=checkIn,checkOut,status`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();

    // Dump raw structure to find where reservations array lives
    const topKeys = Object.keys(data);
    const firstValue = data[topKeys[0]];
    return res.json({ 
      success: true, 
      topKeys, 
      firstValueType: typeof firstValue,
      firstValueIsArray: Array.isArray(firstValue),
      firstValueLength: Array.isArray(firstValue) ? firstValue.length : null,
      firstItem: Array.isArray(firstValue) ? firstValue[0] : firstValue,
      cached: false 
    });

    reservations.forEach(r => {
      if (['confirmed', 'reserved', 'checked_in', 'checked_out', 'owner_stay', 'blocked'].includes(r.status)) {
        const start = new Date(r.checkIn);
        const end   = new Date(r.checkOut);
        for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
          blockedDates.add(d.toISOString().split('T')[0]);
        }
      }
    });

    const result = Array.from(blockedDates);
    setCache(cacheKey, result, 4 * 60 * 60 * 1000); // 4 hour cache
    res.json({ success: true, blockedDates: result, reservationCount: reservations.length, rawStatus: response.status, cached: false });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 4: Get pricing from Supabase ──
app.get('/api/website/pricing', async (req, res) => {
  try {
    const { data, error } = await supabase.from('listing_pricing').select('*');
    if (error) throw error;
    res.json({ success: true, count: data.length, pricing: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 5: Trigger pricing sync ──
app.post('/api/website/sync-pricing', async (req, res) => {
  const secret = req.headers['x-sync-secret'];
  if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json({ success: true, message: 'Pricing sync started in background' });
    const result = await syncPricing();
    console.log('Sync result:', result);
  } catch (e) { console.error('Sync error:', e.message); }
});

// ── Route 6: Reviews (cached 1 hour) ──
app.get('/api/website/reviews', async (req, res) => {
  try {
    const cached = getCache('reviews');
    if (cached) return res.json({ success: true, count: cached.length, reviews: cached, cached: true });
    const token = await getGuestyToken();
    const response = await fetch(
      'https://open-api.guesty.com/v1/reviews?limit=50&fields=rating,publicReview,reviewer,listingId,createdAt',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    const allReviews = data.results || data.data || [];
    const fiveStars = allReviews.filter(r => r.rating >= 5 && r.publicReview?.trim().length > 20);
    setCache('reviews', fiveStars, 60 * 60 * 1000);
    res.json({ success: true, count: fiveStars.length, total: allReviews.length, reviews: fiveStars });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 7: Contact form → Supabase ──
app.post('/api/website/contact', async (req, res) => {
  try {
    const { firstName, lastName, email, interest, message } = req.body;
    const { error } = await supabase.from('website_contacts')
      .insert([{ first_name: firstName, last_name: lastName, email, interest, message }]);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 8: Newsletter signup → Supabase ──
app.post('/api/website/newsletter', async (req, res) => {
  try {
    const { email } = req.body;
    const { error } = await supabase.from('newsletter_subscribers')
      .upsert([{ email, subscribed_at: new Date() }], { onConflict: 'email' });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Health check ──
app.get('/', (req, res) => res.json({
  status: 'Premium Rentals API running',
  cache: {
    listings: cache['listings_all'] ? `cached until ${new Date(cache['listings_all'].expiry).toISOString()}` : 'empty',
    reviews: cache['reviews'] ? `cached until ${new Date(cache['reviews'].expiry).toISOString()}` : 'empty'
  }
}));

// ── Auto pricing sync ──
setTimeout(async () => {
  console.log('Running initial pricing sync on startup...');
  try { await syncPricing(); } catch(e) { console.error('Initial sync failed:', e.message); }
}, 10000);

setInterval(async () => {
  console.log('Running scheduled daily pricing sync...');
  try { await syncPricing(); } catch(e) { console.error('Scheduled sync failed:', e.message); }
}, 24 * 60 * 60 * 1000);

app.listen(process.env.PORT || 3001, () => console.log('Server running on port', process.env.PORT || 3001));
