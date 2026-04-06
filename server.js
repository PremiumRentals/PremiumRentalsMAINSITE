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
const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);

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

// ── Cleaning fee cache (Open API) ──
// BE-API listings don't include cleaning fee — fetched from Open API once per listing
// Cached permanently per server instance since cleaning fees rarely change
const cleaningFeeCache = {};

async function getCleaningFee(listingId) {
  if (cleaningFeeCache[listingId] !== undefined) return cleaningFeeCache[listingId];
  try {
    const token = await getOpenApiToken();
    const res   = await fetch(
      `https://open-api.guesty.com/v1/listings/${listingId}?fields=prices`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const fee  = data?.prices?.cleaningFee || 0;
    cleaningFeeCache[listingId] = fee;
    console.log(`Cleaning fee for ${listingId}: $${fee}`);
    return fee;
  } catch(e) {
    console.warn('Could not fetch cleaning fee for', listingId, e.message);
    cleaningFeeCache[listingId] = 0;
    return 0;
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
// Accommodation = sum of day prices from quote
// Cleaning fee = from Open API listing (cached)
// Service fee + taxes = calculated from env var rates
async function extractPricingFromQuote(quoteData, nights, listingId) {
  const ratePlan   = quoteData.rates?.ratePlans?.[0];
  const days       = ratePlan?.days || [];
  const ratePlanId = ratePlan?.ratePlan?._id || 'default-rateplan-id';
  const fees       = getFeeRates();

  // Accommodation from day prices
  const accommodation = Math.round(
    days.reduce((sum, d) => sum + (d.price || 0), 0) * 100
  ) / 100;

  // Nightly average
  const nightlyAvg = nights > 0 && accommodation > 0
    ? Math.round((accommodation / nights) * 100) / 100
    : 0;

  // Cleaning fee from Open API (cached per listing)
  const cleaningFee = await getCleaningFee(listingId);

  // Service fee on accommodation + cleaning
  const serviceFee = Math.round(
    (accommodation + cleaningFee) * fees.serviceFeeRate * 100
  ) / 100;

  // Taxes on accommodation + cleaning + service
  const taxes = Math.round(
    (accommodation + cleaningFee + serviceFee) * fees.taxRate * 100
  ) / 100;

  // Total
  const total = Math.round(
    (accommodation + cleaningFee + serviceFee + taxes) * 100
  ) / 100;

  console.log(`Pricing [${listingId}]: nightly=$${nightlyAvg} × ${nights} + cleaning=$${cleaningFee} + service=$${serviceFee} + taxes=$${taxes} = $${total}`);

  return {
    nightlyAvg,
    nights,
    accommodation,
    cleaningFee,
    serviceFee,
    taxes,
    additionalFees: 0,
    total,
    ratePlanId,
    feeSource: 'be_api_days'
  };
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
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        accept:         'application/json'
      },
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
        success:   true,
        available: false,
        error:     quoteData.message || quoteData.error || 'Not available for these dates'
      });
    }

    const pricing = await extractPricingFromQuote(quoteData, nights, listingId);

    const result = {
      available: true,
      quoteId:   quoteData._id,
      days:      quoteData.rates?.ratePlans?.[0]?.days || [],
      ...pricing
    };

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

    const blockedDates      = [];
    const checkoutOnlyDates = [];
    const dayData           = {};

    days.forEach((day, index) => {
      const isAvailable    = day.status === 'available';
      const isReserved     = day.status === 'reserved' || day.status === 'booked';
      const isBlocked      = day.status === 'unavailable';
      if (day.minNights) dayData[day.date] = { minNights: day.minNights };
      if (!isAvailable) {
        const prevDay        = index > 0 ? days[index - 1] : null;
        const prevAvailable  = prevDay ? prevDay.status === 'available' : true;
        const isCheckoutOnly = !day.ctd && prevAvailable && (isReserved || isBlocked);
        if (isCheckoutOnly) checkoutOnlyDates.push(day.date);
        else blockedDates.push(day.date);
      }
    });

    const result = {
      blockedDates:      blockedDates.sort(),
      checkoutOnlyDates: checkoutOnlyDates.sort(),
      dayData,
      totalDays: days.length
    };
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
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
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

// ── Route 6: Reviews (Open API) ──
app.get('/api/website/reviews', async (req, res) => {
  try {
    const cached = getCache('reviews');
    if (cached) return res.json({ success: true, count: cached.length, reviews: cached, cached: true });
    const token    = await getOpenApiToken();
    const response = await fetch(
      'https://open-api.guesty.com/v1/reviews?limit=50&fields=rating,publicReview,reviewer,listingId,createdAt',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data       = await response.json();
    const allReviews = data.results || data.data || [];
    const fiveStars  = allReviews.filter(r => r.rating >= 5 && r.publicReview?.trim().length > 20);
    setCache('reviews', fiveStars, 60 * 60 * 1000);
    res.json({ success: true, count: fiveStars.length, reviews: fiveStars });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 7: Contact ──
app.post('/api/website/contact', async (req, res) => {
  try {
    const { firstName, lastName, email, interest, message } = req.body;
    const { error } = await supabase.from('website_contacts')
      .insert([{ first_name: firstName, last_name: lastName, email, interest, message }]);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) {
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
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 9: Fee config ──
app.get('/api/website/fee-config', async (req, res) => {
  try {
    const fees = getFeeRates();
    res.json({
      success: true,
      ...fees,
      note: 'Accommodation from BE-API day prices, cleaning fee from Open API'
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
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

    const openToken = await getOpenApiToken();
    const beToken   = await getBeApiToken();

    // ── Step 1: Find or create guest (Open API) ──
    console.log(`Creating reservation for ${firstName} ${lastName} (${email})`);
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
        body: JSON.stringify({ firstName, lastName, email, phone })
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
          email, name: `${firstName} ${lastName}`, phone: phone || undefined
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
      headers: {
        Authorization:  `Bearer ${beToken}`,
        'Content-Type': 'application/json',
        accept:         'application/json'
      },
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
    const pricing    = await extractPricingFromQuote(quoteData, nights, listingId);
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
        headers: {
          Authorization:  `Bearer ${beToken}`,
          'Content-Type': 'application/json',
          accept:         'application/json'
        },
        body: JSON.stringify({
          ratePlanId,
          ccToken: stripePaymentMethodId,
          guest: {
            firstName,
            lastName,
            email,
            phone: phone || undefined
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

    res.json({
      success:          true,
      reservationId,
      confirmationCode,
      amount:           pricing.total || totalAmount
    });

  } catch(e) {
    console.error('Reserve error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Health check ──
app.get('/', (req, res) => res.json({
  status: 'Premium Rentals API running — BE-API enabled',
  cache: {
    listings:     cache['listings_all'] ? `cached until ${new Date(cache['listings_all'].expiry).toISOString()}` : 'empty',
    reviews:      cache['reviews']      ? `cached until ${new Date(cache['reviews'].expiry).toISOString()}`      : 'empty',
    cleaningFees: `${Object.keys(cleaningFeeCache).length} listings cached`
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
