const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

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
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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

// ── Fee Config System ──
// Priority: 1) Guesty API (property-specific) → 2) Guesty API (account-level) → 3) Railway env vars
let feeConfigCache = null;
let feeConfigExpiry = 0;

async function getFeeConfig() {
  // Return cached if fresh (1 hour)
  if (feeConfigCache && Date.now() < feeConfigExpiry) return feeConfigCache;

  const token = await getGuestyToken();

  // Start with Railway env var fallbacks
  let serviceFeeRate = parseFloat(process.env.SERVICE_FEE_RATE) || 0.135;
  let tourismTaxRate = parseFloat(process.env.TOURISM_TAX_RATE) || 0.02;
  let salesTaxRate   = parseFloat(process.env.SALES_TAX_RATE)   || 0.06;
  let source = 'env_vars';

  // Try to get account-level taxes from Guesty
  try {
    const accountRes = await fetch('https://open-api.guesty.com/v1/accounts/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const accountData = await accountRes.json();
    const accountTaxes = accountData.taxes || [];

    if (accountTaxes.length > 0) {
      // Reset tax rates and rebuild from Guesty data
      tourismTaxRate = 0;
      salesTaxRate   = 0;
      accountTaxes.forEach(tax => {
        if (tax.units === 'PERCENTAGE') {
          const rate = tax.amount / 100;
          if (tax.type === 'TOURISM_TAX') tourismTaxRate += rate;
          else if (tax.type === 'LOCAL_TAX') salesTaxRate += rate;
          else salesTaxRate += rate; // any other tax type adds to sales
        }
      });
      source = 'guesty_account';
      console.log(`Fee config loaded from Guesty: tourism=${tourismTaxRate} sales=${salesTaxRate}`);
    }
  } catch(e) {
    console.warn('Could not fetch account fees from Guesty, using env vars:', e.message);
  }

  feeConfigCache = {
    serviceFeeRate,
    tourismTaxRate,
    salesTaxRate,
    totalTaxRate: tourismTaxRate + salesTaxRate,
    source,
    // Service fee applies to: accommodation + cleaning
    // Tax applies to: accommodation + cleaning + service fee
  };
  feeConfigExpiry = Date.now() + (60 * 60 * 1000); // 1 hour cache
  console.log('Fee config:', JSON.stringify(feeConfigCache));
  return feeConfigCache;
}

// ── Helper: get cleaning fee for a listing ──
function getCleaningFee(listingId) {
  const cached = cache['listings_all'];
  if (!cached) return 0;
  const listing = cached.data?.find(l => l._id === listingId);
  return listing?.prices?.cleaningFee || 0;
}

// ── Helper: get listing-specific tax overrides ──
// If listing has its own taxes array (not using account), use those
// Otherwise returns null (caller should use account-level)
function getListingTaxOverride(listingId) {
  const cached = cache['listings_all'];
  if (!cached) return null;
  const listing = cached.data?.find(l => l._id === listingId);
  if (!listing) return null;

  // If listing uses account taxes, return null so we use account level
  if (listing.useAccountTaxes !== false) return null;

  // Listing has its own taxes
  const taxes = listing.taxes || [];
  if (!taxes.length) return null;

  let tourismTaxRate = 0, salesTaxRate = 0;
  taxes.forEach(tax => {
    if (tax.units === 'PERCENTAGE') {
      const rate = tax.amount / 100;
      if (tax.type === 'TOURISM_TAX') tourismTaxRate += rate;
      else salesTaxRate += rate;
    }
  });
  return { tourismTaxRate, salesTaxRate, totalTaxRate: tourismTaxRate + salesTaxRate };
}

// ── Calculate full price breakdown ──
async function calculatePricing(listingId, days, nights) {
  const fees = await getFeeConfig();

  // Get per-day prices
  const availDays = days.filter(d => d.price);
  let nightlyAvg = 0;
  if (availDays.length > 0) {
    // Use only the days in the stay range (exclude checkout day)
    const stayDays = availDays.slice(0, nights);
    const prices = stayDays.length > 0 ? stayDays : availDays;
    nightlyAvg = Math.round(prices.reduce((a, b) => a + b.price, 0) / prices.length);
  }

  const accommodation = nightlyAvg * nights;
  const cleaningFee   = getCleaningFee(listingId);

  // Service fee: 13.5% of (accommodation + cleaning)
  const serviceFee = Math.round((accommodation + cleaningFee) * fees.serviceFeeRate * 100) / 100;

  // Taxes: check property-specific first, fall back to account level
  const taxOverride = getListingTaxOverride(listingId);
  const taxRate = taxOverride ? taxOverride.totalTaxRate : fees.totalTaxRate;
  const taxes = Math.round((accommodation + cleaningFee + serviceFee) * taxRate * 100) / 100;

  const total = Math.round((accommodation + cleaningFee + serviceFee + taxes) * 100) / 100;

  return {
    nightlyAvg,
    nights,
    accommodation,
    cleaningFee,
    serviceFeeRate: fees.serviceFeeRate,
    serviceFee,
    taxRate,
    taxes,
    total,
    feeSource: taxOverride ? 'listing_specific' : fees.source
  };
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
  const today = new Date();
  const future = new Date(); future.setDate(future.getDate() + 30);
  const fmt = d => d.toISOString().split('T')[0];
  const checkIn = fmt(today), checkOut = fmt(future);
  let synced = 0, failed = 0;
  for (const listing of listings) {
    try {
      await new Promise(r => setTimeout(r, 300));
      const avRes = await fetch(
        `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/${listing._id}?startDate=${checkIn}&endDate=${checkOut}&includeAllotment=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const avData = await avRes.json();
      const days = avData.data?.days || avData.days || [];
      let nightlyRate = null, nextAvailableDate = null;
      const firstAvail = days.find(d => {
        const isAvail = typeof d.allotment === 'number' ? d.allotment > 0 : d.status === 'available';
        return isAvail && d.price;
      });
      if (firstAvail) {
        nightlyRate = firstAvail.price;
        nextAvailableDate = firstAvail.date;
      }
      if (!nightlyRate) nightlyRate = listing.prices?.basePrice || null;
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
    setCache('listings_all', results);
    res.json({ success: true, count: results.length, listings: results, cached: false });
  } catch (e) {
    const stale = cache['listings_all'];
    if (stale) return res.json({ success: true, count: stale.data.length, listings: stale.data, cached: true, stale: true });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 2: Check availability + full accurate pricing ──
app.get('/api/website/availability/:listingId', async (req, res) => {
  try {
    const { listingId } = req.params;
    const { checkIn, checkOut } = req.query;
    if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut required' });
    const cacheKey = `avail_${listingId}_${checkIn}_${checkOut}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ success: true, ...cached, cached: true });
    const token = await getGuestyToken();

    const calRes = await fetch(
      `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/${listingId}?startDate=${checkIn}&endDate=${checkOut}&includeAllotment=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const calData = await calRes.json();
    const days = calData.data?.days || calData.days || [];

    // Check availability
    const hasBlocked = days.some(d => {
      const isAvail = typeof d.allotment === 'number' ? d.allotment > 0 : d.status === 'available';
      return !isAvail;
    });

    // Calculate full accurate pricing
    const nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / 86400000);
    const pricing = await calculatePricing(listingId, days, nights);

    const result = {
      available: !hasBlocked,
      days,
      ...pricing
    };

    setCache(cacheKey, result, 2 * 60 * 1000);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 3: Get listing calendar blocked dates ──
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
      `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/${listingId}?startDate=${startDate}&endDate=${endDate}&includeAllotment=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    const blockedDates = new Set();
    const days = data.data?.days || data.days || [];
    days.forEach(day => {
      const isAvailable = typeof day.allotment === 'number' ? day.allotment > 0 : day.status === 'available';
      if (!isAvailable) blockedDates.add(day.date);
    });
    const blockedArr = Array.from(blockedDates).sort();
    setCache(cacheKey, blockedArr, 4 * 60 * 60 * 1000);
    res.json({ success: true, blockedDates: blockedArr, totalDays: days.length, cached: false });
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
    res.json({ success: true, count: fiveStars.length, reviews: fiveStars });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 7: Contact form ──
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

// ── Route 8: Newsletter ──
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

// ── Route 9: Fee config (for frontend reference) ──
// Frontend can call this to know current rates — cached 1 hour
app.get('/api/website/fee-config', async (req, res) => {
  try {
    const fees = await getFeeConfig();
    res.json({ success: true, ...fees });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 10: Create reservation + charge via Stripe ──
app.post('/api/website/reserve', async (req, res) => {
  try {
    const {
      listingId, checkIn, checkOut, guests,
      firstName, lastName, email, phone, notes,
      stripePaymentMethodId, totalAmount
    } = req.body;

    if (!listingId || !checkIn || !checkOut || !firstName || !lastName || !email || !stripePaymentMethodId) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const token = await getGuestyToken();

    // Step 1: Find or create guest
    console.log(`Creating reservation for ${firstName} ${lastName} (${email})`);
    let guestId = null;
    const guestSearchRes = await fetch(
      `https://open-api.guesty.com/v1/guests?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const guestSearchData = await guestSearchRes.json();
    const existingGuest = guestSearchData.results?.[0];
    if (existingGuest) {
      guestId = existingGuest._id;
      console.log('Found existing guest:', guestId);
    } else {
      const guestCreateRes = await fetch('https://open-api.guesty.com/v1/guests', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email, phone })
      });
      const guestCreateData = await guestCreateRes.json();
      if (!guestCreateData._id) throw new Error('Failed to create guest: ' + JSON.stringify(guestCreateData));
      guestId = guestCreateData._id;
      console.log('Created new guest:', guestId);
    }

    // Step 2: Create reservation
    const reservationRes = await fetch('https://open-api.guesty.com/v1/reservations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listingId,
        checkInDateLocalized: checkIn,
        checkOutDateLocalized: checkOut,
        guestsCount: parseInt(guests) || 1,
        guestId,
        source: 'direct',
        status: 'confirmed',
        money: { invoiceItems: [] },
        guestNotes: notes || ''
      })
    });
    const reservationData = await reservationRes.json();
    if (!reservationData._id) throw new Error('Failed to create reservation: ' + JSON.stringify(reservationData));
    const reservationId = reservationData._id;
    const confirmationCode = reservationData.confirmationCode || reservationId;
    console.log('Created reservation:', reservationId, 'Code:', confirmationCode);

    // Step 3: Charge via Stripe
    const amountInCents = Math.round(totalAmount * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      payment_method: stripePaymentMethodId,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: {
        reservationId, confirmationCode, listingId,
        guestEmail: email, checkIn, checkOut
      },
      description: `Premium Rentals booking ${confirmationCode} — ${checkIn} to ${checkOut}`
    });

    if (paymentIntent.status !== 'succeeded') {
      throw new Error('Payment did not succeed: ' + paymentIntent.status);
    }
    console.log('Payment succeeded:', paymentIntent.id);

    // Step 4: Save to Supabase
    await supabase.from('website_contacts').insert([{
      first_name: firstName, last_name: lastName, email,
      interest: 'booking',
      message: `Reservation ${confirmationCode} | ${checkIn} → ${checkOut} | ${guests} guests | $${totalAmount} | Stripe: ${paymentIntent.id}`
    }]);

    res.json({
      success: true,
      reservationId,
      confirmationCode,
      stripePaymentIntentId: paymentIntent.id,
      amount: totalAmount
    });

  } catch (e) {
    console.error('Reserve error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Health check ──
app.get('/', (req, res) => res.json({
  status: 'Premium Rentals API running',
  cache: {
    listings: cache['listings_all'] ? `cached until ${new Date(cache['listings_all'].expiry).toISOString()}` : 'empty',
    reviews: cache['reviews'] ? `cached until ${new Date(cache['reviews'].expiry).toISOString()}` : 'empty',
    feeConfig: feeConfigCache ? `cached until ${new Date(feeConfigExpiry).toISOString()}` : 'empty'
  }
}));

// ── Daily pricing sync ──
setInterval(async () => {
  console.log('Running scheduled daily pricing sync...');
  try { await syncPricing(); } catch(e) { console.error('Scheduled sync failed:', e.message); }
}, 24 * 60 * 60 * 1000);

// ── Hourly fee config refresh ──
setInterval(async () => {
  console.log('Refreshing fee config...');
  feeConfigCache = null;
  feeConfigExpiry = 0;
  try { await getFeeConfig(); } catch(e) { console.error('Fee config refresh failed:', e.message); }
}, 60 * 60 * 1000);

app.listen(process.env.PORT || 3001, () => {
  console.log('Server running on port', process.env.PORT || 3001);
  // Pre-load fee config on startup
  getFeeConfig().catch(e => console.error('Startup fee config failed:', e.message));
});
