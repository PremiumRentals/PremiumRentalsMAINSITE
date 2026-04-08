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

    // Check prices.fees array for a percentage-based service/management fee
    const extraFees = data?.prices?.fees || data?.prices?.extraFees || [];
    let serviceFeeRate = 0;
    let serviceFeeFlat = 0;
    for (const f of extraFees) {
      const isServiceFee = /management|service|host/i.test(f.name || f.type || '');
      if (isServiceFee) {
        if (f.unit === 'PERCENT' || f.type === 'PERCENT') serviceFeeRate = (f.value || 0) / 100;
        else if (f.unit === 'USD' || f.unit === 'FLAT') serviceFeeFlat = f.value || 0;
        console.log(`Found listing service fee [${listingId}]: name=${f.name} type=${f.type} unit=${f.unit} value=${f.value}`);
      }
    }

    const fees = {
      cleaningFee:                data?.prices?.cleaningFee                || 0,
      extraPersonFee:             data?.prices?.extraPersonFee             || 0,
      guestsIncludedInRegularFee: data?.prices?.guestsIncludedInRegularFee || 2,
      serviceFeeRate,
      serviceFeeFlat,
      rawPrices: data?.prices  // kept for debug — not used in calculations
    };
    listingFeesCache[listingId] = fees;
    console.log(`Listing fees [${listingId}]: cleaning=$${fees.cleaningFee} svcRate=${fees.serviceFeeRate} svcFlat=${fees.serviceFeeFlat} extraPerson=$${fees.extraPersonFee} baseGuests=${fees.guestsIncludedInRegularFee}`);
    return fees;
  } catch(e) {
    console.warn('Could not fetch listing fees for', listingId, e.message);
    const fallback = { cleaningFee: 0, extraPersonFee: 0, guestsIncludedInRegularFee: 2, serviceFeeRate: 0, serviceFeeFlat: 0 };
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

// ── Create Open API V3 quote ──
// strict=false (default): permissive — for pricing/availability checks
// strict=true: enforce all calendar/term rules — for actual reservation creation
async function createV3Quote(openToken, { listingId, checkIn, checkOut, guests }, { strict = false } = {}) {
  const guestCount = parseInt(guests) || 1;
  const body = {
    listingId,
    checkInDateLocalized:  checkIn,
    checkOutDateLocalized: checkOut,
    guestsCount: guestCount,
    numberOfGuests: { numberOfAdults: guestCount, numberOfChildren: 0, numberOfInfants: 0 },
    source: 'OAPI'
  };
  if (strict) {
    body.ignoreCalendar = false;
    body.ignoreTerms    = false;
    body.ignoreBlocks   = false;
  }
  const res = await fetch('https://open-api.guesty.com/v1/quotes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error('Quote parse error: ' + text.slice(0, 200)); }
  return { data, status: res.status };
}

// ── Find first applicable rate plan from V3 quote ──
function getApplicableRatePlan(quote) {
  const ratePlans = quote.rates?.ratePlans || [];
  return ratePlans.find(rp => {
    const na = rp.notApplicable;
    if (!na) return true;
    return !Object.values(na).some(v => v === true);
  }) || ratePlans[0];
}

// ── Extract pricing from Open API V3 quote ──
// V3 money path: rates.ratePlans[n].money.money.* (double-nested)
// Service fee priority:
//   1. V3 invoiceItems (normalType MF/SF or type matching management/service)
//   2. V3 subTotalPrice delta vs accommodation+cleaning
//   3. Listing-level prices.fees serviceFeeRate (from getListingFees)
//   4. Env var SERVICE_FEE_RATE (13.5% default)
function extractV3Pricing(quote, listingFees = null) {
  const rp = getApplicableRatePlan(quote);
  if (!rp) return null;

  const moneyData     = rp.money?.money;
  const nights        = rp.days?.length || 1;
  const accommodation = moneyData?.fareAccommodation || 0;
  const cleaningFee   = moneyData?.fareCleaning || 0;
  const subTotal      = moneyData?.subTotalPrice || (accommodation + cleaningFee);

  // Tier 1: V3 invoice items
  const invoiceItems = moneyData?.invoiceItems || [];
  const feeItem = invoiceItems.find(i =>
    i.normalType === 'MF' || i.normalType === 'SF' ||
    (typeof i.type === 'string' && /management|service/i.test(i.type))
  );
  let serviceFee = feeItem ? Math.abs(feeItem.amount || 0) : 0;
  let feeSource  = feeItem ? 'v3_invoice_item' : null;

  // Tier 2: V3 subTotalPrice delta
  if (!serviceFee) {
    const delta = Math.round((subTotal - accommodation - cleaningFee) * 100) / 100;
    if (delta > 0) { serviceFee = delta; feeSource = 'v3_subtotal_delta'; }
  }

  // Tier 3: listing-level prices.fees (now read from getListingFees)
  if (!serviceFee && listingFees?.serviceFeeRate) {
    serviceFee = Math.round((accommodation + cleaningFee) * listingFees.serviceFeeRate * 100) / 100;
    feeSource = 'listing_prices_fees';
  }
  if (!serviceFee && listingFees?.serviceFeeFlat) {
    serviceFee = listingFees.serviceFeeFlat;
    feeSource = 'listing_prices_fees_flat';
  }

  // Tier 4: env var fallback (SERVICE_FEE_RATE, default 13.5%)
  if (!serviceFee) {
    const { serviceFeeRate } = getFeeRates();
    serviceFee = Math.round((accommodation + cleaningFee) * serviceFeeRate * 100) / 100;
    feeSource = 'env_var_fallback';
  }

  serviceFee = Math.max(0, serviceFee);

  // When service fee comes from fallback (not from V3), V3's totalTaxes was computed
  // without the service fee in the taxable base. Infer the effective tax rate from V3
  // (totalTaxes / subTotal) and reapply it to the full subtotal including service fee.
  let taxes = moneyData?.totalTaxes || 0;
  const v3FeeFromGuesty = feeSource === 'v3_invoice_item' || feeSource === 'v3_subtotal_delta';
  if (!v3FeeFromGuesty && taxes > 0 && subTotal > 0) {
    const effectiveTaxRate = taxes / subTotal;
    taxes = Math.round((accommodation + cleaningFee + serviceFee) * effectiveTaxRate * 100) / 100;
  }

  const total      = Math.round((accommodation + cleaningFee + serviceFee + taxes) * 100) / 100;
  const nightlyAvg = nights > 0 ? Math.round(accommodation / nights * 100) / 100 : 0;
  const ratePlanId = rp.ratePlan?._id || 'default-rateplan-id';

  console.log(`V3 Pricing [${quote.unitId || quote.listingId}] (${feeSource}): nightly=$${nightlyAvg} × ${nights} + cleaning=$${cleaningFee} + svc=$${serviceFee} + taxes=$${taxes} = $${total}`);
  return { nightlyAvg, nights, accommodation, cleaningFee, serviceFee, taxes, total, ratePlanId, quoteId: quote._id, feeSource };
}

// ── Extract pricing from BE-API quote (legacy — used by /availability only) ──
async function extractPricingFromQuote(quoteData, nights, listingId, guests) {
  const ratePlan   = quoteData.rates?.ratePlans?.[0];
  const days       = ratePlan?.days || [];
  const ratePlanId = ratePlan?.ratePlan?._id || 'default-rateplan-id';
  const fees       = getFeeRates();

  const listingFees = await getListingFees(listingId);
  const { cleaningFee, extraPersonFee, guestsIncludedInRegularFee } = listingFees;

  const baseAccommodation = Math.round(days.reduce((sum, d) => sum + (d.price || 0), 0) * 100) / 100;
  const guestCount        = parseInt(guests) || 1;
  const extraGuests       = Math.max(0, guestCount - guestsIncludedInRegularFee);
  const extraPersonTotal  = Math.round(extraPersonFee * extraGuests * nights * 100) / 100;
  const accommodation     = Math.round((baseAccommodation + extraPersonTotal) * 100) / 100;
  const nightlyAvg        = nights > 0 && accommodation > 0 ? Math.round((accommodation / nights) * 100) / 100 : 0;
  const serviceFee        = Math.round((accommodation + cleaningFee) * fees.serviceFeeRate * 100) / 100;
  const taxAmount         = Math.round((accommodation + cleaningFee + serviceFee) * fees.taxRate * 100) / 100;
  const total             = Math.round((accommodation + cleaningFee + serviceFee + taxAmount) * 100) / 100;

  console.log(`BE Pricing [${listingId}] ${guestCount}g: nightly=$${nightlyAvg} × ${nights} = $${total}`);
  return { nightlyAvg, nights, accommodation, cleaningFee, serviceFee, taxes: taxAmount, total, ratePlanId, feeSource: 'be_api_days' };
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

// ── Route 2: Availability + pricing (Open API V3 quote) ──
app.get('/api/website/availability/:listingId', async (req, res) => {
  try {
    const { listingId } = req.params;
    const { checkIn, checkOut, guests } = req.query;
    if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut required' });

    const cacheKey = `avail_${listingId}_${checkIn}_${checkOut}_${guests||1}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json({ success: true, ...cached, cached: true });

    const openToken = await getOpenApiToken();
    const { data: quoteData, status: qStatus } = await createV3Quote(openToken, { listingId, checkIn, checkOut, guests });

    if (qStatus < 200 || qStatus > 299 || !quoteData._id) {
      return res.json({
        success: true, available: false,
        error: quoteData?.message || quoteData?.error || 'Not available for these dates'
      });
    }

    // Check if the applicable rate plan is actually available
    const rp = getApplicableRatePlan(quoteData);
    if (!rp) {
      return res.json({ success: true, available: false, error: 'No available rate plan for these dates' });
    }

    const listingFees = await getListingFees(listingId);
    const pricing = extractV3Pricing(quoteData, listingFees);
    const days    = rp.days || [];
    const result  = { available: true, quoteId: quoteData._id, days, ...pricing };
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

// ── Route 5b: Apply Coupon (Guesty Open API V3) ──
app.post('/api/website/apply-coupon', async (req, res) => {
  try {
    const { listingId, checkIn, checkOut, guests, couponCode } = req.body;
    const code = couponCode?.trim()?.toUpperCase();
    if (!code || !listingId || !checkIn || !checkOut) {
      return res.status(400).json({ success: false, error: 'couponCode, listingId, checkIn, checkOut required' });
    }

    const openToken = await getOpenApiToken();

    // Create V3 quote to get base price
    const { data: quote, status: qStatus } = await createV3Quote(openToken, { listingId, checkIn, checkOut, guests });
    if (qStatus < 200 || qStatus > 299 || !quote._id) {
      return res.status(400).json({ success: false, error: 'Could not create quote for these dates' });
    }
    const listingFees = await getListingFees(listingId);
    const basePricing = extractV3Pricing(quote, listingFees);
    if (!basePricing) return res.status(400).json({ success: false, error: 'Could not read pricing from quote' });

    // Apply coupon via Guesty Open API
    const couponRes = await fetch(
      `https://open-api.guesty.com/v1/quotes/${quote._id}/coupons?mergeAccommodationFarePriceComponents=true`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ coupons: [code] })
      }
    );

    if (couponRes.status === 400) {
      const errData = await couponRes.json().catch(() => ({}));
      return res.json({ success: false, error: errData.message || 'Invalid or expired coupon code' });
    }

    const updatedQuote = await couponRes.json();
    const updatedPricing = extractV3Pricing(updatedQuote, listingFees);
    if (!updatedPricing) return res.json({ success: false, error: 'Could not read updated pricing' });

    const discount = Math.max(0, Math.round((basePricing.total - updatedPricing.total) * 100) / 100);
    if (discount <= 0) {
      return res.json({ success: false, error: 'Coupon is not valid for this property or dates' });
    }

    res.json({
      success:    true,
      couponCode: code,
      discount,
      quoteId:    updatedQuote._id,
      ...updatedPricing
    });
  } catch(e) {
    console.error('Apply coupon error:', e.message);
    res.status(500).json({ success: false, error: 'Could not validate coupon — please try again' });
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
    const { email, name, paymentType } = req.body; // paymentType: 'ach' | 'card' (default)
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customer = customers.data[0];
    if (!customer) {
      customer = await stripe.customers.create({ email, name: name || email });
      console.log('Created Stripe customer:', customer.id);
    } else {
      console.log('Found Stripe customer:', customer.id);
    }
    const paymentMethodTypes = paymentType === 'ach' ? ['us_bank_account'] : ['card'];
    const setupIntent = await stripe.setupIntents.create({
      customer:             customer.id,
      payment_method_types: paymentMethodTypes,
      usage:                'off_session',
      metadata:             { email, name: name || '', paymentType: paymentType || 'card' }
    });
    console.log('Created SetupIntent:', setupIntent.id, '- type:', paymentType || 'card');
    res.json({ success: true, clientSecret: setupIntent.client_secret });
  } catch(e) {
    console.error('SetupIntent error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 11: Reserve (Open API V3 flow) ──
app.post('/api/website/reserve', async (req, res) => {
  try {
    const {
      listingId, checkIn, checkOut, guests,
      firstName, lastName, email, phone,
      stripePaymentMethodId, totalAmount, couponCode
    } = req.body;

    if (!listingId || !checkIn || !checkOut || !firstName || !lastName || !email || !stripePaymentMethodId) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const formattedPhone = formatPhone(phone);
    console.log(`Creating reservation (V3) for ${firstName} ${lastName} (${email})`);

    const openToken = await getOpenApiToken();

    // ── Step 1: Stripe customer record ──
    try {
      const customers = await stripe.customers.list({ email, limit: 1 });
      let customer = customers.data[0];
      if (!customer) customer = await stripe.customers.create({ email, name: `${firstName} ${lastName}`, phone: formattedPhone || undefined });
      try { await stripe.paymentMethods.attach(stripePaymentMethodId, { customer: customer.id }); }
      catch(attachErr) { if (!attachErr.message?.includes('already been attached')) throw attachErr; }
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: stripePaymentMethodId } });
    } catch(e) { console.warn('Stripe customer warning:', e.message); }

    // ── Step 2: Get paymentProviderId ──
    let paymentProviderId = null;
    try {
      const ppRes  = await fetch(`https://open-api.guesty.com/v1/payment-providers/provider-by-listing?listingId=${listingId}`, { headers: { Authorization: `Bearer ${openToken}` } });
      const ppData = await ppRes.json();
      paymentProviderId = ppData.paymentProviderId || ppData._id;
      console.log('Payment provider:', paymentProviderId);
    } catch(e) { console.warn('Could not get payment provider:', e.message); }

    // ── Step 3: Create Open API V3 quote (strict — enforce all calendar/term rules) ──
    console.log('Creating V3 quote...');
    const { data: quoteData, status: qStatus } = await createV3Quote(openToken, { listingId, checkIn, checkOut, guests }, { strict: true });
    if (qStatus < 200 || qStatus > 299 || !quoteData._id) {
      throw new Error('Failed to create quote: ' + JSON.stringify(quoteData).slice(0, 200));
    }
    const listingFees = await getListingFees(listingId);
    const pricing    = extractV3Pricing(quoteData, listingFees);
    let   quoteId    = quoteData._id;
    const ratePlanId = pricing.ratePlanId;
    console.log('V3 Quote created:', quoteId, 'Total:', pricing.total);

    // ── Step 4: Apply coupon if provided ──
    const couponCodeClean = couponCode?.trim()?.toUpperCase();
    if (couponCodeClean) {
      try {
        const couponRes = await fetch(
          `https://open-api.guesty.com/v1/quotes/${quoteId}/coupons?mergeAccommodationFarePriceComponents=true`,
          { method: 'POST', headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ coupons: [couponCodeClean] }) }
        );
        if (couponRes.status === 200) {
          console.log('Coupon applied to quote:', couponCodeClean);
        } else {
          const errBody = await couponRes.text();
          console.warn('Coupon not applied:', couponRes.status, errBody.slice(0, 100));
        }
      } catch(e) { console.warn('Coupon apply error:', e.message); }
    }

    // ── Step 5: Create V3 reservation from quote ──
    console.log('Creating V3 reservation...');
    await new Promise(r => setTimeout(r, 1500));

    const reserveRes  = await fetch('https://open-api.guesty.com/v1/reservations-v3/quote', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status:         'confirmed',
        reservedUntil:  -1,
        guest: {
          firstName,
          lastName,
          email,
          phones: formattedPhone ? [formattedPhone] : undefined
        },
        quoteId,
        ratePlanId,
        ignoreCalendar: false,
        ignoreTerms:    false,
        ignoreBlocks:   false
      })
    });
    const reserveText = await reserveRes.text();
    let reserveData;
    try { reserveData = JSON.parse(reserveText); } catch(e) { throw new Error('Reservation parse error: ' + reserveText.slice(0, 200)); }

    const reservationId    = reserveData.reservationId;
    const guestId          = reserveData.guestId;
    const confirmationCode = reserveData.confirmationCode || reservationId;

    if (!reservationId) {
      const errMsg = JSON.stringify(reserveData);
      if (errMsg.includes('minNights')) throw new Error('This property requires a longer minimum stay. Please go back and select different dates.');
      throw new Error('Failed to create reservation: ' + errMsg.slice(0, 200));
    }
    console.log('V3 Reservation created:', reservationId, 'Code:', confirmationCode, 'Guest:', guestId);

    // ── Step 6: Attach Stripe payment method to Guesty guest ──
    try {
      const pmRes  = await fetch(`https://open-api.guesty.com/v1/guests/${guestId}/payment-methods`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stripeCardToken: stripePaymentMethodId, paymentProviderId, reservationId, skipSetupIntent: true, reuse: true })
      });
      const pmData = await pmRes.json().catch(() => ({}));
      console.log('Payment attached to guest:', JSON.stringify(pmData).slice(0, 200));
    } catch(e) { console.warn('Could not attach payment to guest:', e.message); }

    // ── Step 7: Save to Supabase ──
    const couponNote = couponCodeClean ? ` | Coupon: ${couponCodeClean}` : '';
    await supabase.from('website_contacts').insert([{
      first_name: firstName,
      last_name:  lastName,
      email,
      interest: 'booking',
      message: `Reservation ${confirmationCode} | ${checkIn} → ${checkOut} | ${guests} guests | $${pricing.total || totalAmount}${couponNote} | Guesty ID: ${reservationId}`
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

    const beToken   = await getBeApiToken();
    const openToken = await getOpenApiToken();

    // Get listings and find an available one
    const lr = await fetch('https://booking.guesty.com/api/listings?limit=50', { headers: { Authorization: `Bearer ${beToken}`, accept: 'application/json' } });
    const ld = await lr.json();
    const listings = ld.results || [];

    let usedListingId = null;
    let baseQuoteId   = null;
    for (const l of listings) {
      const qRes = await fetch('https://booking.guesty.com/api/reservations/quotes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${beToken}`, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ listingId: l._id, checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: 1 })
      });
      const qData = await qRes.json();
      if (qData._id) { usedListingId = l._id; baseQuoteId = qData._id; break; }
    }
    if (!usedListingId) return res.json({ error: 'No available listing found', checkIn, checkOut });

    // Fetch base quote via Open API to confirm quoteId is accessible there
    const oqBaseRes = await fetch(`https://open-api.guesty.com/v1/quotes/${baseQuoteId}?mergeAccommodationFarePriceComponents=true`, {
      headers: { Authorization: `Bearer ${openToken}` }
    });
    const oqBaseText = await oqBaseRes.text();
    let oqBaseData;
    try { oqBaseData = JSON.parse(oqBaseText); } catch(e) { oqBaseData = { raw: oqBaseText.slice(0,300) }; }

    // Apply coupon via Open API POST /v1/quotes/{id}/coupons
    const couponRes = await fetch(
      `https://open-api.guesty.com/v1/quotes/${baseQuoteId}/coupons?mergeAccommodationFarePriceComponents=true`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ coupons: [code.toUpperCase()] })
      }
    );
    const couponText = await couponRes.text();
    let couponData;
    try { couponData = JSON.parse(couponText); } catch(e) { couponData = { raw: couponText.slice(0, 500) }; }

    // Extract totals — correct path: rates.ratePlans[0].money.money.*
    const baseMoneyObj  = oqBaseData?.rates?.ratePlans?.[0]?.money?.money;
    const afterMoneyObj = couponData?.rates?.ratePlans?.[0]?.money?.money;
    const baseTotal  = baseMoneyObj?.subTotalPrice;
    const afterTotal = afterMoneyObj?.subTotalPrice;
    const baseTaxes  = baseMoneyObj?.totalTaxes  || 0;
    const afterTaxes = afterMoneyObj?.totalTaxes || 0;
    const baseGrandTotal  = baseTotal  != null ? Math.round((baseTotal  + baseTaxes)  * 100) / 100 : null;
    const afterGrandTotal = afterTotal != null ? Math.round((afterTotal + afterTaxes) * 100) / 100 : null;
    const invoiceItems    = afterMoneyObj?.invoiceItems || [];
    const couponItem      = invoiceItems.find(i => i.type === 'DISCOUNT' || i.normalType === 'CO');

    res.json({
      listingId:   usedListingId,
      beQuoteId:   baseQuoteId,
      checkIn,
      checkOut,
      openApiBaseQuoteStatus: oqBaseRes.status,
      couponApplyStatus: couponRes.status,
      basePricing:  { accommodation: baseMoneyObj?.fareAccommodation, cleaning: baseMoneyObj?.fareCleaning, subtotal: baseTotal, taxes: baseTaxes, total: baseGrandTotal },
      afterPricing: { accommodation: afterMoneyObj?.fareAccommodation, cleaning: afterMoneyObj?.fareCleaning, subtotal: afterTotal, taxes: afterTaxes, total: afterGrandTotal },
      discountApplied: afterGrandTotal != null && baseGrandTotal != null && afterGrandTotal < baseGrandTotal,
      discountAmount: baseGrandTotal != null && afterGrandTotal != null ? Math.round((baseGrandTotal - afterGrandTotal) * 100) / 100 : null,
      couponItem,
      couponsApplied: couponData?.coupons || []
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Debug: test V3 quote for a listing — /api/debug/v3quote?listingId=XXX&checkIn=2026-05-01&checkOut=2026-05-05
app.get('/api/debug/v3quote', async (req, res) => {
  try {
    const d1 = new Date(); d1.setDate(d1.getDate() + 21);
    const d2 = new Date(); d2.setDate(d2.getDate() + 25);
    let { listingId, checkIn = d1.toISOString().split('T')[0], checkOut = d2.toISOString().split('T')[0], guests = 2 } = req.query;

    const openToken = await getOpenApiToken();

    // Auto-fetch a listingId if not provided
    if (!listingId) {
      const beToken = await getBeApiToken();
      const lr = await fetch('https://booking.guesty.com/api/listings?limit=10', { headers: { Authorization: `Bearer ${beToken}`, accept: 'application/json' } });
      const ld = await lr.json();
      listingId = ld.results?.[0]?._id;
      if (!listingId) return res.status(400).json({ error: 'No listings found — pass listingId param' });
    }

    // Try permissive (no ignore flags)
    const permRes = await fetch('https://open-api.guesty.com/v1/quotes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId, checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: parseInt(guests), numberOfGuests: { numberOfAdults: parseInt(guests), numberOfChildren: 0, numberOfInfants: 0 }, source: 'OAPI' })
    });
    const permText = await permRes.text();
    let permData; try { permData = JSON.parse(permText); } catch(e) { permData = { raw: permText.slice(0, 500) }; }

    // Try strict (all false)
    const strictRes = await fetch('https://open-api.guesty.com/v1/quotes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId, checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: parseInt(guests), numberOfGuests: { numberOfAdults: parseInt(guests), numberOfChildren: 0, numberOfInfants: 0 }, source: 'OAPI', ignoreCalendar: false, ignoreTerms: false, ignoreBlocks: false })
    });
    const strictText = await strictRes.text();
    let strictData; try { strictData = JSON.parse(strictText); } catch(e) { strictData = { raw: strictText.slice(0, 500) }; }

    const summarize = (d, status) => {
      const extracted = d._id ? extractV3Pricing(d) : null;
      return {
        httpStatus: status,
        quoteId: d._id,
        error: d.error || d.message || d.msg,
        ratePlanCount: d.rates?.ratePlans?.length,
        extractedPricing: extracted,
        ratePlans: d.rates?.ratePlans?.map(rp => ({
          ratePlanId: rp.ratePlan?._id,
          name: rp.ratePlan?.name,
          notApplicable: rp.notApplicable,
          allMoneyFields: rp.money?.money,
          invoiceItems: (rp.money?.money?.invoiceItems || []).map(i => ({
            type: i.type, normalType: i.normalType, amount: i.amount, title: i.title
          })),
        }))
      };
    };

    res.json({
      listingId, checkIn, checkOut, guests,
      permissive: summarize(permData, permRes.status),
      strict: summarize(strictData, strictRes.status)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/listing-fees', async (req, res) => {
  try {
    let { listingId } = req.query;
    const beToken   = await getBeApiToken();
    const openToken = await getOpenApiToken();
    if (!listingId) {
      const lr = await fetch('https://booking.guesty.com/api/listings?limit=5', { headers: { Authorization: `Bearer ${beToken}`, accept: 'application/json' } });
      const ld = await lr.json();
      listingId = ld.results?.[0]?._id;
      if (!listingId) return res.status(400).json({ error: 'No listings found' });
    }
    // BE-API listing — full prices + terms object
    const beRes  = await fetch(`https://booking.guesty.com/api/listings/${listingId}`, { headers: { Authorization: `Bearer ${beToken}`, accept: 'application/json' } });
    const beData = await beRes.json();
    // Open API listing prices
    const openRes  = await fetch(`https://open-api.guesty.com/v1/listings/${listingId}?fields=prices`, { headers: { Authorization: `Bearer ${openToken}` } });
    const openData = await openRes.json();
    res.json({
      listingId,
      beApi: {
        prices: beData?.prices,
        terms:  beData?.terms,
        fees:   beData?.fees,
      },
      openApi: {
        prices: openData?.prices,
      }
    });
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

// ── Payment settings helper ──
async function getPaymentSettings() {
  try {
    const { data } = await supabase.from('payment_settings').select('key, value');
    const s = { acceptCards: true, acceptAch: true };
    (data || []).forEach(r => {
      if (r.key === 'accept_cards') s.acceptCards = r.value !== 'false';
      if (r.key === 'accept_ach')   s.acceptAch   = r.value !== 'false';
    });
    return s;
  } catch { return { acceptCards: true, acceptAch: true }; }
}

// ── Admin: Get payment settings ──
app.get('/api/admin/payment-settings', requireAdmin, async (req, res) => {
  res.json({ success: true, ...(await getPaymentSettings()) });
});

// ── Admin: Update payment settings ──
app.put('/api/admin/payment-settings', requireAdmin, async (req, res) => {
  const { acceptCards, acceptAch } = req.body;
  if (!acceptCards && !acceptAch)
    return res.status(400).json({ error: 'At least one payment method must be enabled' });
  try {
    await supabase.from('payment_settings').upsert([
      { key: 'accept_cards', value: String(Boolean(acceptCards)), updated_at: new Date().toISOString() },
      { key: 'accept_ach',   value: String(Boolean(acceptAch)),   updated_at: new Date().toISOString() }
    ], { onConflict: 'key' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Public: Get payment settings (for checkout) ──
app.get('/api/payment-settings', async (req, res) => {
  res.json({ success: true, ...(await getPaymentSettings()) });
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
      _id: l._id, title: l.title, nickname: l.nickname, address: l.address, picture: l.picture
    }))});
    // Trigger a fresh fetch if cache empty
    const token = await getBeApiToken();
    const r = await fetch('https://booking.guesty.com/api/listings?limit=100&fields=_id,title,nickname,address,picture', {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
    });
    const data = await r.json();
    res.json({ success: true, listings: (data.results || []).map(l => ({
      _id: l._id, title: l.title, nickname: l.nickname, address: l.address, picture: l.picture
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
      customNightlyRate, cleaningFee, serviceFee, taxes, couponCode,
      holdType, holdHours,
      notes,
      acceptCards, acceptAch
    } = req.body;

    if (!listingId || !checkIn || !checkOut) {
      return res.status(400).json({ error: 'listingId, checkIn, checkOut required' });
    }

    const nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / 86400000);
    const accommodationTotal = customNightlyRate ? customNightlyRate * nights : null;
    const total = accommodationTotal != null
      ? accommodationTotal + (cleaningFee || 0) + (serviceFee || 0) + (taxes || 0)
      : null;

    // Inquiry quotes never expire — only reserved holds have an expiry
    const expiresAt = (holdType === 'reserved' && holdHours)
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
      service_fee:      serviceFee || null,
      taxes:            taxes || null,
      coupon_code:      couponCode || null,
      total,
      hold_type:        holdType || 'inquiry',
      hold_hours:       holdHours || 24,
      status:           'pending',
      notes:            notes || null,
      expires_at:       expiresAt,
      accept_cards:     acceptCards !== false,
      accept_ach:       acceptAch === true
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

// ── Public: Reserve from admin quote (guest-facing booking) ──
app.post('/api/quote/:id/reserve', async (req, res) => {
  try {
    const { id } = req.params;
    const { stripePaymentMethodId, guestFirstName, guestLastName, guestEmail, guestPhone } = req.body;
    if (!stripePaymentMethodId) return res.status(400).json({ error: 'Payment method required' });

    // Fetch the admin quote
    const { data: quote, error: qErr } = await supabase
      .from('admin_quotes').select('*').eq('id', id).single();
    if (qErr || !quote) return res.status(404).json({ error: 'Quote not found' });
    // Booked/cancelled quotes can't be re-used; expired reserved quotes can still be booked
    if (quote.status === 'booked') return res.status(400).json({ error: 'This quote has already been booked.' });
    if (quote.status === 'cancelled') return res.status(400).json({ error: 'This quote has been cancelled.' });
    // Check if dates have already passed
    const checkInDate = new Date(quote.check_in + 'T12:00:00');
    if (checkInDate < new Date()) return res.status(400).json({ error: 'These dates have already passed.' });

    const openToken = await getOpenApiToken();
    const listingId = quote.listing_id;
    const checkIn   = quote.check_in;
    const checkOut  = quote.check_out;
    const firstName = guestFirstName || quote.guest_first_name || 'Guest';
    const lastName  = guestLastName  || quote.guest_last_name  || '';
    const email     = guestEmail     || quote.guest_email      || '';
    const phone     = guestPhone     || quote.guest_phone      || '';

    // Step 1: Stripe customer
    let customerId;
    try {
      const customers = await stripe.customers.list({ email, limit: 1 });
      let customer = customers.data[0];
      if (!customer) customer = await stripe.customers.create({ email, name: `${firstName} ${lastName}`.trim() });
      customerId = customer.id;
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: stripePaymentMethodId } });
    } catch(e) { console.warn('Stripe customer warning:', e.message); }

    // Step 1b: ACH 4-day validation
    try {
      const pm = await stripe.paymentMethods.retrieve(stripePaymentMethodId);
      if (pm.type === 'us_bank_account') {
        const checkInDate = new Date(checkIn + 'T12:00:00');
        const minDate     = new Date();
        minDate.setDate(minDate.getDate() + 4);
        minDate.setHours(0, 0, 0, 0);
        if (checkInDate < minDate) {
          return res.status(400).json({ error: 'ACH bank transfers require check-in at least 4 days from today to allow funds to clear. Please use a credit/debit card or contact us.' });
        }
      }
    } catch(e) { console.warn('Could not validate ACH timing:', e.message); }

    // Step 2: Get payment provider
    let paymentProviderId = null;
    try {
      const ppRes  = await fetch(`https://open-api.guesty.com/v1/payment-providers/provider-by-listing?listingId=${listingId}`, { headers: { Authorization: `Bearer ${openToken}` } });
      const ppData = await ppRes.json();
      paymentProviderId = ppData.paymentProviderId || ppData._id;
    } catch(e) { console.warn('Could not get payment provider:', e.message); }

    // Step 3: Create V3 quote for date validation
    const listingFees = await getListingFees(listingId);
    const { data: quoteData, status: qStatus } = await createV3Quote(openToken, { listingId, checkIn, checkOut, guests: quote.guests || 1 }, { strict: true });
    if (qStatus < 200 || qStatus > 299 || !quoteData._id) {
      return res.status(400).json({ error: 'Dates are no longer available' });
    }
    const pricing    = extractV3Pricing(quoteData, listingFees);
    const quoteId    = quoteData._id;
    const ratePlanId = pricing.ratePlanId;

    // Step 4: Create reservation with custom pricing override if admin set a custom rate
    const accommodationOverride = quote.accommodation_total || pricing.accommodation;
    const reservationBody = {
      status: 'confirmed',
      reservedUntil: -1,
      guest: {
        firstName, lastName, email,
        ...(phone ? { phone: formatPhone(phone) } : {})
      },
      quoteId,
      ratePlanId,
      ...(paymentProviderId ? { paymentProviderId } : {})
    };
    const resRes = await fetch('https://open-api.guesty.com/v1/reservations-v3/quote', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(reservationBody)
    });
    const resData = await resRes.json();
    if (!resData._id) throw new Error(resData.message || resData.error || 'Reservation failed');
    const reservationId = resData._id;
    const guestId = resData.guestId || resData.guest?._id;

    // Step 5: Attach payment method to guest
    if (guestId) {
      try {
        const pm = await stripe.paymentMethods.retrieve(stripePaymentMethodId);
        await fetch(`https://open-api.guesty.com/v1/guests/${guestId}/payment-methods`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${openToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'stripe', token: stripePaymentMethodId,
            isDefault: true,
            ...(paymentProviderId ? { paymentProviderId } : {})
          })
        });
      } catch(e) { console.warn('Payment method attach warning:', e.message); }
    }

    // Step 6: Mark admin quote as accepted
    await supabase.from('admin_quotes').update({
      status: 'accepted',
      guesty_reservation_id: reservationId
    }).eq('id', id);

    res.json({ success: true, reservationId, confirmationCode: resData.confirmationCode });
  } catch(e) {
    console.error('Quote reserve error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
