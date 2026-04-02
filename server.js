const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    'https://premiumrentals.ai',
    'https://www.premiumrentals.ai',
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

// ── Route 1: Get all active listings ──
app.get('/api/website/listings', async (req, res) => {
  try {
    const token = await getGuestyToken();
    const { limit = 24 } = req.query;
    const response = await fetch(
      `https://open-api.guesty.com/v1/listings?limit=${limit}&fields=_id,title,nickname,address,bedrooms,bathrooms,accommodates,prices,pictures,publicDescription,amenities,active,tags`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    const results = (data.results || []).filter(l => l.active !== false);
    res.json({ success: true, count: results.length, listings: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 2: Check availability + pricing ──
app.get('/api/website/availability/:listingId', async (req, res) => {
  try {
    const token = await getGuestyToken();
    const { listingId } = req.params;
    const { checkIn, checkOut } = req.query;
    if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut required' });
    const response = await fetch(
      `https://open-api.guesty.com/v1/availability-pricing/api/v3/listings/${listingId}?startDate=${checkIn}&endDate=${checkOut}&currency=USD`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 3: Contact form → Supabase ──
app.post('/api/website/contact', async (req, res) => {
  try {
    const { firstName, lastName, email, interest, message } = req.body;
    const { error } = await supabase
      .from('website_contacts')
      .insert([{ first_name: firstName, last_name: lastName, email, interest, message }]);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route 4: Newsletter signup → Supabase ──
app.post('/api/website/newsletter', async (req, res) => {
  try {
    const { email } = req.body;
    const { error } = await supabase
      .from('newsletter_subscribers')
      .upsert([{ email, subscribed_at: new Date() }], { onConflict: 'email' });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Health check ──
app.get('/', (req, res) => res.json({ status: 'Premium Rentals API running' }));

app.listen(process.env.PORT || 3001, () => console.log('Server running on port', process.env.PORT || 3001));
