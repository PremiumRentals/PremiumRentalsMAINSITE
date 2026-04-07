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
    'https://premiumrentals.com',
    'https://www.premiumrentals.com',
    'https://premium-rentals-mainsite.vercel.app',
    'http://localhost:3000'
  ]
}));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Format phone to E.164 for Guesty ──
// Handles all common formats guests might enter:
// 2085550100        → +12085550100  (US 10 digits)
// 12085550100       → +12085550100  (US with country code)
// (208) 555-0100    → +12085550100  (formatted US)
// +12085550100      → +12085550100  (already correct)
// +441234567890     → +441234567890 (international)
// 441234567890      → +441234567890 (international no +)
function formatPhone(phone) {
  if (!phone) return undefined;
  const cleaned = phone.trim();
  // Already E.164 with + prefix
  if (cleaned.startsWith('+')) {
    const digits = cleaned.replace(/\D/g, '');
    return digits.length >= 7 ? `+${digits}` : undefined;
  }
  // Strip all non-digits
  const digits = cleaned.replace(/\D/g, '');
  if (!digits || digits.length < 7) return undefined;
  // 10 digits — assume US/Canada
  if (digits.length === 10) return `+1${digits}`;
  // 11 digits starting with 1 — US with country code
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // Any other length — prepend + and trust the guest
  return `+${digits}`;
}

// ── Open API Auth ──
let openApiToken = null;
let openApiTokenExpiry = 0;

async function getOpenApiToken() {
  if (openApiToken && Date.now() < openApiTokenExpiry) return openApiToken;
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
  if (!d.access_token) throw new Error('Open API auth failed: ' + JSON.stringify(d));
  openApiToken = d.access_token;
  openApiTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  console.log('Open API token refreshed');
  return openApiToken;
}

// ── BE-API Auth ──
let beApiToken = null;
let beApiTokenExpiry = 0;

async function getBeApiToken() {
  if (beApiToken && Date.now() < beApiTokenExpiry) return beApiToken;
  const res = await fetch('https://booking.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'booking_engine:api',
      client_id: process.env.GUESTY_BE_CLIENT_ID,
      client_secret: process.env.GUESTY_BE_CLIENT_SECRET
    })
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('BE-API auth failed: ' + JSON.stringify(d));
  beApiToken = d.access_token;
  beApiTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  console.log('BE-API token refreshed');
  return beApiToken;
}

// ── Cache Layer ──
const cache = {};
function getCache(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() > entry.expiry) { delete cache[key]; return null; }
  return entry.data;
}
function setCache(key, data, ttl) {
  cache[key] = { data, expiry: Date.now() + ttl };
}

// ── Listing fees cache (Open API) ──
// BE-API listings don't include cleaning fee or extra person fee
// Fetched once from Open API and cached permanently per server instance
const listingFeesCache = {};

// ── Listing coordinates (Open API) ──
// BE-API listings don't include lat/lng for the map
// Fetched from Open API once per hour and merged into listings response
// ── Open API listing enrichment (full publicDescription) ──
// Fetched without fields filter so we get all sub-fields (space, access, neighborhood)
async function getOpenApiListingData() {
  const cached = getCache('openapi_listing_data');
  if (cached) return cached;
  try {
    const token = await getOpenApiToken();
    // Fetch all listings from Open API — no fields filter so nested publicDescription sub-fields are returned
    // Also fetch page 2 if needed (limit=100 per page)
    let results = [];
    let skip = 0;
    while (true) {
      const res  = await fetch(
        `https://open-api.guesty.com/v1/listings?limit=100&skip=${skip}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      const page = data.results || data.data || [];
      results = results.concat(page);
      if (page.length < 100) break;
      skip += 100;
    }
    const enriched = {};
    results.forEach(l => {
      const desc = l.publicDescription || {};
      enriched[l._id] = {
        publicDescription: (desc.summary || desc.space || desc.access || desc.neighborhood)
          ? desc : null
      };
    });
    const descCount = Object.values(enriched).filter(e => e.publicDescription).length;
    // Log a sample to verify field structure
    const sample = results.slice(0,2).map(l => ({ id: l._id, descKeys: Object.keys(l.publicDescription||{}), summaryLen: (l.publicDescription?.summary||'').length }));
    console.log(`Open API enrichment: ${results.length} listings, ${descCount} with description. Sample: ${JSON.stringify(sample)}`);
    setCache('openapi_listing_data', enriched, 60 * 60 * 1000);
    return enriched;
  } catch(e) {
    console.warn('Could not fetch Open API listing data:', e.message);
    return {};
  }
}

async function getListingFees(listingId) {
  if (listingFeesCache[listingId]) return listingFeesCache[listingId];
  try {
    const token = await getOpenApiToken();
    const res   = await fetch(
      `https://open-api.guesty.com/v1/listings/${listingId}?fields=prices`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const fees = {
      cleaningFee:                data?.prices?.cleaningFee                || 0,
      extraPersonFee:             data?.prices?.extraPersonFee             || 0,
      guestsIncludedInRegularFee: data?.prices?.guestsIncludedInRegularFee || 2
    };
    listingFeesCache[listingId] = fees;
    console.log(`Listing fees [${listingId}]: cleaning=$${fees.cleaningFee} extraPerson=$${fees.extraPersonFee} baseGuests=${fees.guestsIncludedInRegularFee}`);
    return fees;
  } catch(e) {
    console.warn('Could not fetch listing fees for', listingId, e.message);
    const fallback = { cleaningFee: 0, extraPersonFee: 0, guestsIncludedInRegularFee: 2 };
    listingFeesCache[listingId] = fallback;
    return fallback;
  }
}

// ── Fee rates from env vars ──
function getFeeRates() {
  return {
    serviceFeeRate: parseFloat(process.env.SERVICE_FEE_RATE) || 0.135,
    taxRate:        (parseFloat(process.env.TOURISM_TAX_RATE) || 0.02) +
                    (parseFloat(process.env.SALES_TAX_RATE)   || 0.06)
  };
}

// ── Extract pricing from BE-API quote ──
// BE-API quote returns: ratePlan, inquiryId, days only — no money/invoice items
// Extra person fee baked into accommodation total
async function extractPricingFromQuote(quoteData, nights, listingId, guests) {
  const ratePlan   = quoteData.rates?.ratePlans?.[0];
  const days       = ratePlan?.days || [];
  const ratePlanId = ratePlan?.ratePlan?._id || 'default-rateplan-id';
  const fees       = getFeeRates();

  const listingFees = await getListingFees(listingId);
  const { cleaningFee, extraPersonFee, guestsIncludedInRegularFee } = listingFees;

  // Base accommodation from day prices
  const baseAccommodation = Math.round(
    days.reduce((sum, d) => sum + (d.price || 0), 0) * 100
  ) / 100;

  // Extra person fee baked into accommodation
  const guestCount       = parseInt(guests) || 1;
  const extraGuests      = Math.max(0, guestCount - guestsIncludedInRegularFee);
  const extraPersonTotal = Math.round(extraPersonFee * extraGuests * nights * 100) / 100;

  const accommodation = Math.round((baseAccommodation + extraPersonTotal) * 100) / 100;
  const nightlyAvg    = nights > 0 && accommodation > 0
    ? Math.round((accommodation / nights) * 100) / 100 : 0;

  const serviceFee = Math.round((accommodation + cleaningFee) * fees.serviceFeeRate * 100) / 100;
  const taxes      = Math.round((accommodation + cleaningFee + serviceFee) * fees.taxRate * 100) / 100;
  const total      = Math.round((accommodation + cleaningFee + serviceFee + taxes) * 100) / 100;

  console.log(`Pricing [${listingId}] ${guestCount} guests: nightly=$${nightlyAvg} × ${nights} + cleaning=$${cleaningFee} + service=$${serviceFee} + taxes=$${taxes} = $${total}`);

  return { nightlyAvg, nights, accommodation, cleaningFee, serviceFee, taxes, total, ratePlanId, feeSource: 'be_api_days' };
}

// ── Pricing sync ──
async function syncPricing() {
  console.log('Starting pricing sync...');
  const token = await getOpenApiToken();
  const listRes = await fetch('https://open-api.guesty.com/v1/listings?limit=100', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const listData = await listRes.json();
  const listings = (listData.results || []).filter(l => l.active !== false);
  let synced = 0, failed = 0;
  for (const listing of listings) {
    try {
      await new Promise(r => setTimeout(r, 300));
      const { error } = await supabase.from('listing_pricing').upsert({
        listing_id:   listing._id,
        nightly_rate: listing.prices?.basePrice || null,
        currency:     'USD',
        updated_at:   new Date().toISOString()
      }, { onConflict: 'listing_id' });
      if (error) throw error;
      synced++;
    } catch(e) { console.error(`Failed to sync ${listing._id}:`, e.message); failed++; }
  }
  console.log(`Pricing sync complete: ${synced} synced, ${failed} failed`);
  return { synced, failed, total: listings.length };
}

// ── Route 1: Listings (BE-API) ──
app.get('/api/website/listings', async (req, res) => {
  try {
    const cached = getCache('listings_all');
    if (cached) return res.json({ success: true, count: cached.length, listings: cached, cached: true });
    const token    = await getBeApiToken();
    const response = await fetch('https://booking.guesty.com/api/listings?limit=100', {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
    });
    const data    = await response.json();
    const results = data.results || [];
    // ── Enrich with full publicDescription from Open API ──
    try {
      const enriched = await getOpenApiListingData();
      let descCount = 0;
      results.forEach(l => {
        const e = enriched[l._id];
        if (e?.publicDescription) {
          l.publicDescription = Object.assign({}, l.publicDescription || {}, e.publicDescription);
          descCount++;
        }
      });
      console.log(`Description enrichment: ${descCount} listings updated`);
    } catch(e) { console.warn('Description merge failed:', e.message); }

    setCache('listings_all', results, 5 * 60 * 1000);
    res.json({ success: true, count: results.length, listings: results, cached: false });
  } catch(e) {
    const stale = cache['listings_all'];
    if (stale) return res.json({ success: true, count: stale.data.length, listings: stale.data, cached: true, stale: true });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 2: Availability + pricing (BE-API quote) ──
app.get('/api/website/availability/:listingId', async (req, res) => {
  try {
    const { listingId } = req.params;
    const { checkIn, checkOut, guests } = req.query;
    if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut required' });

    const cacheKey = `avail_${listingId}_${checkIn}_${checkOut}_${guests||1}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json({ success: true, ...cached, cached: true });

    const token  = await getBeApiToken();
    const nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / 86400000);

    const quoteRes = await fetch('https://booking.guesty.com/api/reservations/quotes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        listingId,
        checkInDateLocalized:  checkIn,
        checkOutDateLocalized: checkOut,
        guestsCount: parseInt(guests) || 1
      })
    });

    const quoteText = await quoteRes.text();
    let quoteData;
    try { quoteData = JSON.parse(quoteText); } catch(e) {
      throw new Error('Quote parse error: ' + quoteText.slice(0, 200));
    }

    if (quoteRes.status !== 200 || !quoteData._id) {
      return res.json({
        success: true, available: false,
        error: quoteData.message || quoteData.error || 'Not available for these dates'
      });
    }

    const pricing = await extractPricingFromQuote(quoteData, nights, listingId, guests);
    const result  = { available: true, quoteId: quoteData._id, days: quoteData.rates?.ratePlans?.[0]?.days || [], ...pricing };
    setCache(cacheKey, result, 30 * 1000);
    res.json({ success: true, ...result });

  } catch(e) {
    console.error('Availability error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 3: Calendar (BE-API) ──
app.get('/api/website/calendar/:listingId', async (req, res) => {
  try {
    const { listingId } = req.params;
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });

    const cacheKey = `cal_${listingId}_${startDate}_${endDate}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json({ success: true, ...cached, cached: true });

    const token    = await getBeApiToken();
    const response = await fetch(
      `https://booking.guesty.com/api/listings/${listingId}/calendar?from=${startDate}&to=${endDate}`,
      { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } }
    );
    const days = await response.json();
    if (!Array.isArray(days)) throw new Error('Invalid calendar response');

    const blockedDates = [], checkoutOnlyDates = [], dayData = {};
    days.forEach((day, index) => {
      const isAvailable = day.status === 'available';
      const isReserved  = day.status === 'reserved' || day.status === 'booked';
      const isBlocked   = day.status === 'unavailable';
      if (day.minNights) dayData[day.date] = { minNights: day.minNights };
      if (!isAvailable) {
        const prevDay       = index > 0 ? days[index - 1] : null;
        const prevAvailable = prevDay ? prevDay.status === 'available' : true;
        const isCheckoutOnly = !day.ctd && prevAvailable && (isReserved || isBlocked);
        if (isCheckoutOnly) checkoutOnlyDates.push(day.date);
        else blockedDates.push(day.date);
      }
    });

    const result = { blockedDates: blockedDates.sort(), checkoutOnlyDates: checkoutOnlyDates.sort(), dayData, totalDays: days.length };
    setCache(cacheKey, result, 30 * 1000);
    res.json({ success: true, ...result, cached: false });

  } catch(e) {
    console.error('Calendar error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 4: Pricing from Supabase ──
app.get('/api/website/pricing', async (req, res) => {
  try {
    const { data, error } = await supabase.from('listing_pricing').select('*');
    if (error) throw error;
    res.json({ success: true, count: data.length, pricing: data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Route 5: Sync pricing ──
app.post('/api/website/sync-pricing', async (req, res) => {
  const secret = req.headers['x-sync-secret'];
  if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json({ success: true, message: 'Pricing sync started' });
    const result = await syncPricing();
    console.log('Sync result:', result);
  } catch(e) { console.error('Sync error:', e.message); }
});

// ── Route 5b: Apply Coupon ──
app.post('/api/website/apply-coupon', async (req, res) => {
  try {
    const { listingId, checkIn, checkOut, guests, couponCode, quoteId } = req.body;
    if (!couponCode?.trim()) return res.status(400).json({ success: false, error: 'Coupon code required' });

    const token = await getBeApiToken();

    // If we already have a quoteId, try applying coupon to it directly
    let targetQuoteId = quoteId;

    // If no quoteId provided, create a fresh quote first
    if (!targetQuoteId) {
      if (!listingId || !checkIn || !checkOut) {
        return res.status(400).json({ success: false, error: 'listingId, checkIn, checkOut required' });
      }
      const qRes = await fetch('https://booking.guesty.com/api/reservations/quotes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ listingId, checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: parseInt(guests) || 1 })
      });
      const qData = await qRes.json();
      if (!qData._id) return res.status(400).json({ success: false, error: 'Could not create quote to validate coupon' });
      targetQuoteId = qData._id;
    }

    // Apply coupon to the quote
    const couponRes = await fetch(`https://booking.guesty.com/api/reservations/quotes/${targetQuoteId}/coupon`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ couponCode: couponCode.trim().toUpperCase() })
    });
    const couponData = await couponRes.json();

    if (couponRes.status !== 200 || couponData.error || couponData.message?.toLowerCase().includes('invalid')) {
      return res.json({ success: false, error: 'Invalid or expired coupon code' });
    }

    // Re-fetch the updated quote to get new pricing
    const updatedRes = await fetch(`https://booking.guesty.com/api/reservations/quotes/${targetQuoteId}`, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
    });
    const updatedQuote = await updatedRes.json();
    const nights = Math.ceil((new Date(checkOut || updatedQuote.checkOutDateLocalized) - new Date(checkIn || updatedQuote.checkInDateLocalized)) / 86400000);
    const pricing = await extractPricingFromQuote(updatedQuote, nights, listingId || updatedQuote.listingId, guests);

    // Try to find discount amount
    const discount = couponData.discount || couponData.amount || updatedQuote.money?.couponDiscount || 0;

    res.json({ success: true, quoteId: targetQuoteId, discount, ...pricing, couponCode: couponCode.trim().toUpperCase() });
  } catch(e) {
    console.error('Apply coupon error:', e.message);
    res.status(500).json({ success: false, error: 'Could not apply coupon — please try again' });
  }
});

// ── Route 6: Reviews (Open API) ──
app.get('/api/website/reviews', async (req, res) => {
  try {
    const listingId = req.query.listingId;
    const cacheKey  = listingId ? `reviews_${listingId}` : 'reviews_all';
    const cached    = getCache(cacheKey);
    // Use !== null check — empty array [] is truthy but should NOT be a cache hit
    if (cached !== null && cached.length > 0) return res.json({ success: true, count: cached.length, reviews: cached, cached: true });

    // Check if we already have all reviews cached — avoid re-fetching Guesty
    let fourPlus = getCache('reviews_all');
    if (!fourPlus || fourPlus.length === 0) {
      const token = await getOpenApiToken();
      // Fetch without fields filter — rating/text are nested in rawReview
      const response = await fetch(
        'https://open-api.guesty.com/v1/reviews?limit=200',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json();
      const allReviews = data.results || data.data || [];

      // Guesty stores rating in rawReview.overall_rating and text in rawReview.public_review
      fourPlus = allReviews
        .filter(r => {
          const rating = r.rawReview?.overall_rating ?? r.rating;
          const text   = r.rawReview?.public_review  ?? r.publicReview ?? '';
          return rating >= 4 && text.trim().length > 20;
        })
        .map(r => ({
          _id:          r._id,
          listingId:    r.listingId,
          createdAt:    r.createdAt,
          rating:       r.rawReview?.overall_rating ?? r.rating ?? 5,
          publicReview: r.rawReview?.public_review  ?? r.publicReview ?? '',
          reviewer:     r.reviewer || null
        }));

      console.log(`Reviews fetched from Guesty: ${allReviews.length} raw, ${fourPlus.length} qualifying (4★+)`);
      if (fourPlus.length > 0) setCache('reviews_all', fourPlus, 60 * 60 * 1000);
    }

    // Match by listingId OR nested listing._id (Guesty sometimes puts it in either place)
    const filtered = listingId
      ? fourPlus.filter(r => r.listingId === listingId || r.listing?._id === listingId)
      : fourPlus;
    console.log(`Reviews for listing ${listingId||'all'}: ${filtered.length} (of ${fourPlus.length} total qualifying)`);
    if (filtered.length > 0) setCache(cacheKey, filtered, 60 * 60 * 1000);
    res.json({ success: true, count: filtered.length, reviews: filtered, total: fourPlus.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Route 7: Contact ──
app.post('/api/website/contact', async (req, res) => {
  try {
    const { firstName, lastName, email, interest, message } = req.body;
    const { error } = await supabase.from('website_contacts')
      .insert([{ first_name: firstName, last_name: lastName, email, interest, message }]);
    if (error) throw error;
    // Notify via Formspree (non-blocking)
    fetch('https://formspree.io/f/xeepnaeo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        name: `${firstName || ''} ${lastName || ''}`.trim(),
        email: email || '',
        _subject: `New Inquiry — ${interest || 'General'} — Premium Rentals`,
        interest: interest || '',
        message: message || ''
      })
    }).catch(() => {}); // fire-and-forget, never block the response
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Route 8: Newsletter ──
app.post('/api/website/newsletter', async (req, res) => {
  try {
    const { email } = req.body;
    const { error } = await supabase.from('newsletter_subscribers')
      .upsert([{ email, subscribed_at: new Date() }], { onConflict: 'email' });
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Route 9: Fee config ──
app.get('/api/website/fee-config', async (req, res) => {
  try {
    const fees = getFeeRates();
    res.json({ success: true, ...fees, note: 'Accommodation from BE-API day prices, cleaning + extra person from Open API' });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Route 10: Create SetupIntent ──
app.post('/api/website/create-setup-intent', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customer = customers.data[0];
    if (!customer) {
      customer = await stripe.customers.create({ email, name: name || email });
      console.log('Created Stripe customer:', customer.id);
    } else {
      console.log('Found Stripe customer:', customer.id);
    }
    const setupIntent = await stripe.setupIntents.create({
      customer:             customer.id,
      payment_method_types: ['card'],
      usage:                'off_session',
      metadata:             { email, name: name || '' }
    });
    console.log('Created SetupIntent:', setupIntent.id);
    res.json({ success: true, clientSecret: setupIntent.client_secret });
  } catch(e) {
    console.error('SetupIntent error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 11: Reserve ──
app.post('/api/website/reserve', async (req, res) => {
  try {
    const {
      listingId, checkIn, checkOut, guests,
      firstName, lastName, email, phone,
      stripePaymentMethodId, totalAmount
    } = req.body;

    if (!listingId || !checkIn || !checkOut || !firstName || !lastName || !email || !stripePaymentMethodId) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Format phone to E.164 — handles any format guest enters
    const formattedPhone = formatPhone(phone);
    console.log(`Creating reservation for ${firstName} ${lastName} (${email}) phone: ${formattedPhone}`);

    const openToken = await getOpenApiToken();
    const beToken   = await getBeApiToken();

    // ── Step 1: Find or create guest (Open API) ──
    let guestId = null;
    const guestSearchRes  = await fetch(
      `https://open-api.guesty.com/v1/guests?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${openToken}` } }
    );
    const guestSearchData = await guestSearchRes.json();
    const existingGuest   = guestSearchData.results?.[0];
    if (existingGuest) {
      guestId = existingGuest._id;
      console.log('Found existing guest:', guestId);
    } else {
      const guestCreateRes  = await fetch('https://open-api.guesty.com/v1/guests', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          phone: formattedPhone  // E.164 formatted
        })
      });
      const guestCreateData = await guestCreateRes.json();
      if (!guestCreateData._id) throw new Error('Failed to create guest: ' + JSON.stringify(guestCreateData));
      guestId = guestCreateData._id;
      console.log('Created new guest:', guestId);
    }

    // ── Step 2: Save to Stripe customer ──
    try {
      const customers = await stripe.customers.list({ email, limit: 1 });
      let customer = customers.data[0];
      if (!customer) {
        customer = await stripe.customers.create({
          email,
          name:  `${firstName} ${lastName}`,
          phone: formattedPhone || undefined
        });
      }
      try {
        await stripe.paymentMethods.attach(stripePaymentMethodId, { customer: customer.id });
      } catch(attachErr) {
        if (!attachErr.message?.includes('already been attached')) throw attachErr;
      }
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: stripePaymentMethodId }
      });
      console.log('Payment method saved to Stripe customer:', customer.id);
    } catch(e) {
      console.warn('Stripe customer warning:', e.message);
    }

    // ── Step 3: Get paymentProviderId (Open API) ──
    let paymentProviderId = null;
    try {
      const ppRes  = await fetch(
        `https://open-api.guesty.com/v1/payment-providers/provider-by-listing?listingId=${listingId}`,
        { headers: { Authorization: `Bearer ${openToken}` } }
      );
      const ppData = await ppRes.json();
      paymentProviderId = ppData.paymentProviderId || ppData._id;
      console.log('Payment provider:', paymentProviderId);
    } catch(e) {
      console.warn('Could not get payment provider:', e.message);
    }

    // ── Step 4: Create fresh quote (BE-API) ──
    console.log('Creating fresh quote...');
    const quoteRes = await fetch('https://booking.guesty.com/api/reservations/quotes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${beToken}`, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        listingId,
        checkInDateLocalized:  checkIn,
        checkOutDateLocalized: checkOut,
        guestsCount: parseInt(guests) || 1
      })
    });
    const quoteText = await quoteRes.text();
    let quoteData;
    try { quoteData = JSON.parse(quoteText); } catch(e) {
      throw new Error('Quote parse error: ' + quoteText.slice(0, 200));
    }
    if (!quoteData._id) throw new Error('Failed to create quote: ' + JSON.stringify(quoteData).slice(0, 200));

    const nights     = Math.ceil((new Date(checkOut) - new Date(checkIn)) / 86400000);
    const pricing    = await extractPricingFromQuote(quoteData, nights, listingId, guests);
    const quoteId    = quoteData._id;
    const ratePlanId = pricing.ratePlanId;
    console.log('Quote created:', quoteId, 'Total:', pricing.total);

    // ── Step 5: Create instant reservation (BE-API) ──
    console.log('Creating instant reservation from quote...');
    await new Promise(r => setTimeout(r, 2000));

    const reserveRes = await fetch(
      `https://booking.guesty.com/api/reservations/quotes/${quoteId}/instant`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${beToken}`, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          ratePlanId,
          ccToken: stripePaymentMethodId,
          guest: {
            firstName,
            lastName,
            email,
            phone: formattedPhone || undefined  // E.164 formatted
          }
        })
      }
    );
    const reserveText = await reserveRes.text();
    let reserveData;
    try { reserveData = JSON.parse(reserveText); } catch(e) {
      throw new Error('Reservation parse error: ' + reserveText.slice(0, 200));
    }
    if (!reserveData._id) {
      const errMsg = JSON.stringify(reserveData);
      if (errMsg.includes('minNights')) {
        throw new Error('This property requires a longer minimum stay. Please go back and select different dates.');
      }
      throw new Error('Failed to create reservation: ' + errMsg.slice(0, 200));
    }

    const reservationId    = reserveData._id;
    const confirmationCode = reserveData.confirmationCode || reservationId;
    console.log('Created reservation:', reservationId, 'Code:', confirmationCode);

    // ── Step 6: Attach payment to Guesty guest for automation (Open API) ──
    console.log('Attaching payment to Guesty guest for automation...');
    try {
      const pmRes  = await fetch(
        `https://open-api.guesty.com/v1/guests/${guestId}/payment-methods`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stripeCardToken:   stripePaymentMethodId,
            paymentProviderId: paymentProviderId,
            reservationId:     reservationId,
            skipSetupIntent:   true,
            reuse:             true
          })
        }
      );
      const pmText = await pmRes.text();
      let pmData;
      try { pmData = JSON.parse(pmText); } catch(e) { pmData = { raw: pmText }; }
      console.log('Payment attached to guest:', JSON.stringify(pmData).slice(0, 200));
    } catch(e) {
      console.warn('Could not attach payment to guest:', e.message);
    }

    // ── Step 7: Save to Supabase ──
    await supabase.from('website_contacts').insert([{
      first_name: firstName,
      last_name:  lastName,
      email,
      interest: 'booking',
      message:  `Reservation ${confirmationCode} | ${checkIn} → ${checkOut} | ${guests} guests | $${pricing.total || totalAmount} | Guesty ID: ${reservationId}`
    }]);

    res.json({ success: true, reservationId, confirmationCode, amount: pricing.total || totalAmount });

  } catch(e) {
    console.error('Reserve error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Debug: full review diagnostic ──
app.get('/api/debug/reviews', async (req, res) => {
  try {
    // Clear reviews cache so we always get fresh data here
    Object.keys(cache).filter(k => k.startsWith('reviews')).forEach(k => delete cache[k]);
    const token = await getOpenApiToken();
    const response = await fetch('https://open-api.guesty.com/v1/reviews?limit=200', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    const all = data.results || data.data || [];

    // Show raw field structure of first review
    const rawSample = all[0] || null;

    // Filter the same way the main route does
    const qualifying = all.filter(r => {
      const rating = r.rawReview?.overall_rating ?? r.rating;
      const text   = r.rawReview?.public_review  ?? r.publicReview ?? '';
      return rating >= 4 && text.trim().length > 20;
    });

    // Show unique listingIds from qualifying reviews
    const listingIds = [...new Set(qualifying.map(r => r.listingId).filter(Boolean))];

    // Cross-check: do these listingIds appear in the BE-API listings?
    const listings = getCache('listings_all') || [];
    const beIds    = new Set(listings.map(l => l._id));
    const matched  = listingIds.filter(id => beIds.has(id));
    const unmatched = listingIds.filter(id => !beIds.has(id));

    res.json({
      rawTotal: all.length,
      qualifying: qualifying.length,
      topLevelFields: rawSample ? Object.keys(rawSample) : [],
      rawReviewFields: rawSample?.rawReview ? Object.keys(rawSample.rawReview) : [],
      sampleRating: rawSample?.rawReview?.overall_rating ?? rawSample?.rating,
      sampleText: (rawSample?.rawReview?.public_review ?? rawSample?.publicReview ?? '').slice(0,100),
      sampleListingId: rawSample?.listingId,
      uniqueListingIds: listingIds.length,
      matchedToBEApi: matched.length,
      unmatchedIds: unmatched.slice(0,5),
      qualifyingSample: qualifying.slice(0,3).map(r => ({
        listingId: r.listingId,
        rating: r.rawReview?.overall_rating ?? r.rating,
        textPreview: (r.rawReview?.public_review ?? r.publicReview ?? '').slice(0,60)
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Debug: coupon test — hit /api/debug/coupon?code=TRAVELLIKETIFF
app.get('/api/debug/coupon', async (req, res) => {
  try {
    const d1 = new Date(); d1.setDate(d1.getDate()+21);
    const d2 = new Date(); d2.setDate(d2.getDate()+25);
    const defaultIn  = d1.toISOString().split('T')[0];
    const defaultOut = d2.toISOString().split('T')[0];
    const { code, checkIn = defaultIn, checkOut = defaultOut } = req.query;
    if (!code) return res.status(400).json({ error: 'code param required' });
    const token = await getBeApiToken();

    // Get all listings and try each until a quote succeeds
    const cached = getCache('listings_all');
    let listings = cached?.length ? cached : [];
    if (!listings.length) {
      const lr = await fetch('https://booking.guesty.com/api/listings?limit=50', { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } });
      const ld = await lr.json();
      listings = ld.results || [];
    }

    // Find first available listing (quote without coupon)
    let usedListingId = null;
    for (const l of listings) {
      const qRes = await fetch('https://booking.guesty.com/api/reservations/quotes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ listingId: l._id, checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: 1 })
      });
      const qData = await qRes.json();
      if (qData._id) { usedListingId = l._id; break; }
    }
    if (!usedListingId) return res.json({ error: 'No available listing found for these dates', checkIn, checkOut });

    // Baseline quote (no coupon) to compare totals
    const baseRes = await fetch('https://booking.guesty.com/api/reservations/quotes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ listingId: usedListingId, checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: 1 })
    });
    const baseData = await baseRes.json();
    const baseTotal = baseData.rates?.ratePlans?.[0]?.money?.invoiceItems?.reduce((s,i)=>s+(i.amount||0),0)
      || baseData.money?.invoiceItems?.reduce((s,i)=>s+(i.amount||0),0)
      || baseData.money?.total || baseData.money?.fareAccommodation || '(check money field)';

    // Try creating quotes with coupon in body
    const attempts = ['couponCode','promoCode','promotionCode','coupon','promo','discountCode'];
    const results = {};
    for (const field of attempts) {
      const r = await fetch('https://booking.guesty.com/api/reservations/quotes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ listingId: usedListingId, checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: 1, [field]: code })
      });
      const d = await r.json();
      const total = d.rates?.ratePlans?.[0]?.money?.invoiceItems?.reduce((s,i)=>s+(i.amount||0),0)
        || d.money?.invoiceItems?.reduce((s,i)=>s+(i.amount||0),0)
        || d.money?.total || d.money?.fareAccommodation;
      const invoiceItems = d.rates?.ratePlans?.[0]?.money?.invoiceItems || d.money?.invoiceItems || [];
      results[field] = { status: r.status, quoteId: d._id, total, discountApplied: total !== baseTotal, invoiceItems };
    }

    res.json({ usedListingId, checkIn, checkOut, couponCode: code, baseTotal, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/listings', async (req, res) => {
  try {
    delete cache['listings_all'];
    delete cache['openapi_listing_data'];
    // Force fresh fetch and enrichment
    const token    = await getBeApiToken();
    const response = await fetch('https://booking.guesty.com/api/listings?limit=100', {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
    });
    const data    = await response.json();
    const results = data.results || [];
    const openData = await getOpenApiListingData();
    const cities = [...new Set(results.map(l => l.address?.city).filter(Boolean))];
    const descSample = Object.entries(openData).slice(0, 3).map(([id, v]) => ({
      id, descFields: Object.keys(v.publicDescription || {})
    }));
    res.json({ totalListings: results.length, uniqueCities: cities, descSample, openApiCount: Object.keys(openData).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// ADMIN PORTAL — quote management
// ════════════════════════════════════════════════════════════
const crypto = require('crypto');

// Simple in-memory session store (clears on server restart — fine for internal tool)
const adminSessions = new Map(); // token → expiry timestamp

function requireAdmin(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  const expiry = adminSessions.get(token);
  if (!token || !expiry || Date.now() > expiry) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Admin Login ──
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPw = process.env.ADMIN_PASSWORD;
  if (!adminPw) return res.status(500).json({ error: 'ADMIN_PASSWORD env var not set' });
  if (password !== adminPw) return res.status(401).json({ error: 'Invalid password' });
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + 24 * 60 * 60 * 1000); // 24h session
  res.json({ success: true, token });
});

// ── Admin: verify session ──
app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ success: true, loggedIn: true });
});

// ── Admin: Init DB (creates quotes table in Supabase if not exists) ──
app.post('/api/admin/init-db', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS admin_quotes (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          guesty_reservation_id TEXT,
          listing_id TEXT NOT NULL,
          listing_name TEXT,
          listing_photo TEXT,
          guest_first_name TEXT NOT NULL,
          guest_last_name TEXT NOT NULL,
          guest_email TEXT NOT NULL,
          guest_phone TEXT,
          check_in DATE NOT NULL,
          check_out DATE NOT NULL,
          nights INT NOT NULL,
          custom_nightly_rate DECIMAL,
          accommodation_total DECIMAL,
          cleaning_fee DECIMAL,
          taxes DECIMAL,
          total DECIMAL,
          hold_type TEXT DEFAULT 'inquiry',
          hold_hours INT DEFAULT 24,
          status TEXT DEFAULT 'pending',
          notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ
        );
      `
    });
    if (error) throw error;
    res.json({ success: true });
  } catch(e) {
    // Table might already exist or rpc not available — try a test insert instead
    res.json({ note: 'Run SQL manually in Supabase if needed', error: e.message });
  }
});

// ── Admin: Get listings (for dropdown) ──
app.get('/api/admin/listings', requireAdmin, async (req, res) => {
  try {
    const listings = getCache('listings_all') || [];
    if (listings.length) return res.json({ success: true, listings: listings.map(l => ({
      _id: l._id, title: l.title, address: l.address, picture: l.picture
    }))});
    // Trigger a fresh fetch if cache empty
    const token = await getBeApiToken();
    const r = await fetch('https://booking.guesty.com/api/listings?limit=100&fields=_id,title,address,picture', {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
    });
    const data = await r.json();
    res.json({ success: true, listings: (data.results || []).map(l => ({
      _id: l._id, title: l.title, address: l.address, picture: l.picture
    }))});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: List quotes ──
app.get('/api/admin/quotes', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_quotes')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, quotes: data || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Create quote ──
app.post('/api/admin/quotes', requireAdmin, async (req, res) => {
  try {
    const {
      listingId, listingName, listingPhoto,
      guestFirstName, guestLastName, guestEmail, guestPhone,
      checkIn, checkOut,
      customNightlyRate, cleaningFee, taxes,
      holdType, holdHours,
      notes
    } = req.body;

    if (!listingId || !guestEmail || !checkIn || !checkOut) {
      return res.status(400).json({ error: 'listingId, guestEmail, checkIn, checkOut required' });
    }

    const nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / 86400000);
    const accommodationTotal = customNightlyRate ? customNightlyRate * nights : null;
    const total = accommodationTotal != null
      ? accommodationTotal + (cleaningFee || 0) + (taxes || 0)
      : null;

    const expiresAt = holdHours
      ? new Date(Date.now() + holdHours * 60 * 60 * 1000).toISOString()
      : null;

    // Try to create reservation in Guesty (Open API) for holds
    let guestyReservationId = null;
    if (holdType === 'reserved' || holdType === 'inquiry') {
      try {
        const token = await getOpenApiToken();
        const guestBody = {
          listingId,
          checkInDateLocalized:  checkIn,
          checkOutDateLocalized: checkOut,
          status: holdType,
          guestsCount: 1,
          guest: {
            firstName: guestFirstName || 'Guest',
            lastName:  guestLastName  || '',
            email:     guestEmail,
            ...(guestPhone ? { phone: formatPhone(guestPhone) } : {})
          }
        };
        if (accommodationTotal) {
          guestBody.money = { fareAccommodation: accommodationTotal, currency: 'USD' };
        }
        const gRes = await fetch('https://open-api.guesty.com/v1/reservations', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(guestBody)
        });
        const gData = await gRes.json();
        if (gData._id) guestyReservationId = gData._id;
        else console.warn('Guesty reservation creation:', JSON.stringify(gData).slice(0, 200));
      } catch(e) {
        console.warn('Could not create Guesty reservation:', e.message);
        // Don't fail — we still save the quote locally
      }
    }

    const { data, error } = await supabase.from('admin_quotes').insert([{
      guesty_reservation_id: guestyReservationId,
      listing_id:       listingId,
      listing_name:     listingName,
      listing_photo:    listingPhoto,
      guest_first_name: guestFirstName,
      guest_last_name:  guestLastName,
      guest_email:      guestEmail,
      guest_phone:      guestPhone,
      check_in:         checkIn,
      check_out:        checkOut,
      nights,
      custom_nightly_rate:  customNightlyRate || null,
      accommodation_total:  accommodationTotal,
      cleaning_fee:     cleaningFee || null,
      taxes:            taxes || null,
      total,
      hold_type:        holdType || 'inquiry',
      hold_hours:       holdHours || 24,
      status:           'pending',
      notes:            notes || null,
      expires_at:       expiresAt
    }]).select().single();

    if (error) throw error;
    res.json({ success: true, quote: data, guestyReservationId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Update quote ──
app.put('/api/admin/quotes/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['status', 'notes', 'custom_nightly_rate', 'accommodation_total', 'cleaning_fee', 'taxes', 'total'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    const { data, error } = await supabase.from('admin_quotes').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, quote: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Cancel quote ──
app.delete('/api/admin/quotes/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: quote } = await supabase.from('admin_quotes').select('guesty_reservation_id').eq('id', id).single();
    // Cancel Guesty reservation if exists
    if (quote?.guesty_reservation_id) {
      try {
        const token = await getOpenApiToken();
        await fetch(`https://open-api.guesty.com/v1/reservations/${quote.guesty_reservation_id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled' })
        });
      } catch(e) { console.warn('Could not cancel Guesty reservation:', e.message); }
    }
    await supabase.from('admin_quotes').update({ status: 'cancelled' }).eq('id', id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Public: Get quote by ID (for guest quote page) ──
app.get('/api/quote/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_quotes')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Quote not found' });
    // Don't expose internal fields
    const { guesty_reservation_id, ...pub } = data;
    res.json({ success: true, quote: pub });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Health check ──
app.get('/', (req, res) => res.json({
  status: 'Premium Rentals API running — BE-API enabled',
  cache: {
    listings:    cache['listings_all'] ? `cached until ${new Date(cache['listings_all'].expiry).toISOString()}` : 'empty',
    reviews:     cache['reviews']      ? `cached until ${new Date(cache['reviews'].expiry).toISOString()}`      : 'empty',
    listingFees: `${Object.keys(listingFeesCache).length} listings cached`
  }
}));

// ── Scheduled tasks ──
setInterval(async () => {
  console.log('Running scheduled daily pricing sync...');
  try { await syncPricing(); } catch(e) { console.error('Scheduled sync failed:', e.message); }
}, 24 * 60 * 60 * 1000);

setInterval(async () => {
  console.log('Refreshing BE-API token...');
  beApiToken = null; beApiTokenExpiry = 0;
  try { await getBeApiToken(); } catch(e) { console.error('BE-API token refresh failed:', e.message); }
}, 23 * 60 * 60 * 1000);

app.listen(process.env.PORT || 3001, () => {
  console.log('Server running on port', process.env.PORT || 3001);
  getBeApiToken().catch(e => console.error('BE-API startup failed:', e.message));
  getOpenApiToken().catch(e => console.error('Open API startup failed:', e.message));
});
