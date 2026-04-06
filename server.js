const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qs = require('qs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Guesty auth ───────────────────────────────────────────────────────────

let guestyToken = null;
let guestyTokenExpiry = null;

async function getGuestyToken() {
  if (guestyToken && guestyTokenExpiry && Date.now() < guestyTokenExpiry) return guestyToken;
  const res = await axios({
    method: 'POST',
    url: 'https://open-api.guesty.com/oauth2/token',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    data: qs.stringify({
      grant_type: 'client_credentials',
      scope: 'open-api',
      client_id: process.env.GUESTY_CLIENT_ID,
      client_secret: process.env.GUESTY_CLIENT_SECRET
    })
  });
  guestyToken = res.data.access_token;
  guestyTokenExpiry = Date.now() + (res.data.expires_in - 300) * 1000;
  console.log('Guesty token obtained');
  return guestyToken;
}

async function guestyRequest(method, path, data = null) {
  const token = await getGuestyToken();
  const url = `https://open-api.guesty.com/v1${path}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
  if (data) headers['Content-Type'] = 'application/json';
  try {
    const res = await axios({ method, url, headers, data, maxRedirects: 10 });
    return res.data;
  } catch (err) {
    console.error(`Guesty error [${method} ${url}]:`, err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 200));
    throw err;
  }
}

// ─── Podium OAuth token management ────────────────────────────────────────

async function getPodiumTokens() {
  const { data } = await supabase
    .from('settings')
    .select('podium_access_token, podium_refresh_token, podium_token_expiry, podium_location_uid')
    .eq('id', 1)
    .single();
  return data;
}

async function savePodiumTokens(access_token, refresh_token, expires_in = 36000) {
  const expiry = new Date(Date.now() + (expires_in - 300) * 1000).toISOString();
  await supabase.from('settings').update({
    podium_access_token: access_token,
    podium_refresh_token: refresh_token,
    podium_token_expiry: expiry,
  }).eq('id', 1);
  console.log('Podium tokens saved, expires:', expiry);
}

async function getValidPodiumToken() {
  const tokens = await getPodiumTokens();
  if (!tokens?.podium_access_token) throw new Error('No Podium token — visit /auth/podium to authenticate');
  const expiry = tokens.podium_token_expiry ? new Date(tokens.podium_token_expiry) : null;
  if (expiry && Date.now() < expiry.getTime()) return tokens.podium_access_token;
  console.log('Podium token expired, refreshing...');
  const res = await axios.post('https://api.podium.com/oauth/token', {
    client_id: process.env.PODIUM_CLIENT_ID,
    client_secret: process.env.PODIUM_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: tokens.podium_refresh_token,
  }, { headers: { 'Content-Type': 'application/json' } });
  await savePodiumTokens(res.data.access_token, res.data.refresh_token, res.data.expires_in);
  return res.data.access_token;
}

async function podiumRequest(method, path, data = null) {
  const token = await getValidPodiumToken();
  const url = `https://api.podium.com/v4${path}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
  if (data) headers['Content-Type'] = 'application/json';
  try {
    const res = await axios({ method, url, headers, data });
    return res.data;
  } catch (err) {
    console.error(`Podium error [${method} ${url}]:`, err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 200));
    throw err;
  }
}

async function sendPodiumReply(podiumConversationId, body) {
  const tokens = await getPodiumTokens();
  const locationUid = tokens?.podium_location_uid || process.env.PODIUM_LOCATION_UID;
  return podiumRequest('POST', `/conversations/${podiumConversationId}/messages`, { body, locationUid });
}

// ─── Podium OAuth routes ───────────────────────────────────────────────────

app.get('/auth/podium', (req, res) => {
  const scopes = [
    'read_messages', 'write_messages',
    'read_contacts', 'write_contacts',
    'read_locations', 'read_organizations',
  ].join(' ');
  const url = new URL('https://api.podium.com/oauth/authorize');
  url.searchParams.set('client_id', process.env.PODIUM_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.PODIUM_REDIRECT_URI);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', 'premiumrentals_autopilot');
  console.log('Redirecting to Podium OAuth:', url.toString());
  res.redirect(url.toString());
});

app.get('/auth/podium/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Podium auth failed: ${error}</h2>`);
  if (!code) return res.status(400).send('<h2>No code received from Podium</h2>');
  try {
    const tokenRes = await axios.post('https://api.podium.com/oauth/token', {
      client_id: process.env.PODIUM_CLIENT_ID,
      client_secret: process.env.PODIUM_CLIENT_SECRET,
      redirect_uri: process.env.PODIUM_REDIRECT_URI,
      grant_type: 'authorization_code',
      code,
    }, { headers: { 'Content-Type': 'application/json' } });
    await savePodiumTokens(tokenRes.data.access_token, tokenRes.data.refresh_token, tokenRes.data.expires_in || 36000);

    // Auto-fetch and store location UID
    try {
      const locations = await podiumRequest('GET', '/locations');
      const locationUid = locations?.data?.[0]?.uid || locations?.[0]?.uid;
      if (locationUid) {
        await supabase.from('settings').update({ podium_location_uid: locationUid }).eq('id', 1);
        console.log('Podium location UID saved:', locationUid);
      }
    } catch (e) { console.log('Could not auto-fetch location UID:', e.message); }

    res.send(`
      <html><body style="font-family:'Inter',sans-serif;max-width:480px;margin:80px auto;padding:24px">
        <div style="background:#f7f5f2;border:1px solid #eeede9;padding:32px;border-radius:2px">
          <div style="font-size:13px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#C9A96E;margin-bottom:12px">Podium</div>
          <h2 style="font-family:'Playfair Display',serif;font-size:24px;font-weight:500;color:#1a1a1a;margin-bottom:12px">Connected successfully</h2>
          <p style="font-size:14px;color:#6b6b6b;line-height:1.7;margin-bottom:24px">Access token stored and will auto-refresh. Inbound SMS messages will now appear in your unified inbox.</p>
          <a href="https://premiumrentals.ai" style="background:#C9A96E;color:#fff;padding:12px 28px;border-radius:2px;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.5px">Go to Dashboard</a>
        </div>
      </body></html>
    `);
  } catch (err) {
    console.error('Podium token exchange error:', err.response?.data || err.message);
    res.status(500).send(`<h2>Token exchange failed</h2><pre>${JSON.stringify(err.response?.data, null, 2)}</pre>`);
  }
});

app.get('/auth/podium/status', async (req, res) => {
  try {
    const tokens = await getPodiumTokens();
    const hasToken = !!tokens?.podium_access_token;
    const expiry = tokens?.podium_token_expiry;
    const expired = expiry ? new Date(expiry) < new Date() : true;
    res.json({
      connected: hasToken && !expired,
      hasToken,
      expired,
      expiry,
      locationUid: tokens?.podium_location_uid || null,
      authUrl: `${process.env.API_URL}/auth/podium`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Phone normalization ───────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.slice(-10);
}

// ─── Podium guest matching ─────────────────────────────────────────────────

async function matchPodiumGuestToGuesty(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  // Check cache first — only use if reservation is still active
  const { data: cached } = await supabase
    .from('podium_contacts').select('*').eq('phone', normalized).single()
    .catch(() => ({ data: null }));

  if (cached?.reservation_id) {
    const checkOut = cached.check_out ? new Date(cached.check_out) : null;
    const still_active = checkOut && checkOut > new Date();
    if (still_active) {
      console.log(`Podium cache hit for ${normalized} → ${cached.reservation_id}`);
      return cached;
    }
    console.log(`Podium cache expired for ${normalized}, re-searching Guesty`);
  }

  // Search Guesty reservations by phone
  let matched = null;
  try {
    const data = await guestyRequest('GET', `/reservations?limit=50&sort=-checkIn&fields=_id listingId checkIn checkOut status confirmationCode guestsCount keyCode source guest`);
    const reservations = data?.results || [];
    for (const r of reservations) {
      const guestPhone = r.guest?.phone || r.guest?.phones?.[0]?.number || r.guest?.phones?.[0] || '';
      const guestNormalized = normalizePhone(guestPhone);
      if (guestNormalized && guestNormalized === normalized) {
        const checkOut = r.checkOut ? new Date(r.checkOut) : null;
        const oneDayAgo = new Date(Date.now() - 86400000);
        if (!checkOut || checkOut > oneDayAgo) { matched = r; break; }
      }
    }
  } catch (e) { console.error('Guesty phone search error:', e.message); }

  const contactRecord = {
    phone: normalized,
    last_matched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (matched) {
    const full = await guestyRequest('GET', `/reservations/${matched._id}`).catch(() => matched);
    const guestName = full.guest?.fullName || [full.guest?.firstName, full.guest?.lastName].filter(Boolean).join(' ') || 'Guest';
    Object.assign(contactRecord, {
      guest_name: guestName,
      guest_email: full.guest?.email || null,
      reservation_id: full._id,
      listing_id: full.listingId,
      check_in: full.checkIn,
      check_out: full.checkOut,
      door_code: full.keyCode || full.notes?.guest || null,
      confirmation_code: full.confirmationCode || null,
      guests_count: full.guestsCount || null,
      platform: full.source || 'Direct',
    });
    console.log(`Podium guest matched: ${guestName} → ${full._id}`);
  } else {
    console.log(`No Guesty reservation found for phone ${normalized}`);
  }

  await supabase.from('podium_contacts').upsert(contactRecord, { onConflict: 'phone', ignoreDuplicates: false });
  return matched ? contactRecord : null;
}

// ─── Calendar helpers ──────────────────────────────────────────────────────

async function getListingCalendar(listingId, from, to) {
  try {
    const data = await guestyRequest('GET', `/listings/${listingId}/calendar?from=${from}&to=${to}`);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function getListingReservations(listingId, from, to) {
  try {
    const data = await guestyRequest('GET', `/reservations?listingId=${listingId}&checkIn=${from}&checkOut=${to}&fields=_id checkIn checkOut status guestId`);
    return data?.results || [];
  } catch { return []; }
}

function formatCalendarContext(calendar, reservations) {
  if (!calendar.length) return 'Calendar data unavailable.';
  const available = calendar.filter(d => d.status === 'available');
  const booked = calendar.filter(d => d.blocks?.r || d.status === 'unavailable');
  const lines = ['CALENDAR CONTEXT (next 60 days):'];
  lines.push(`Available dates: ${available.length}`);
  lines.push(`Booked/blocked dates: ${booked.length}`);
  if (reservations.length) {
    lines.push('Upcoming reservations:');
    reservations.forEach(r => {
      const cin = r.checkIn ? new Date(r.checkIn).toISOString().split('T')[0] : '?';
      const cout = r.checkOut ? new Date(r.checkOut).toISOString().split('T')[0] : '?';
      lines.push(`  • ${cin} → ${cout} (${r.status})`);
    });
  }
  const sorted = [...reservations].sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));
  for (let i = 0; i < sorted.length - 1; i++) {
    const cout = new Date(sorted[i].checkOut).toISOString().split('T')[0];
    const nextCin = new Date(sorted[i + 1].checkIn).toISOString().split('T')[0];
    if (cout === nextCin) lines.push(`  ⚠ Same-day turnover on ${cout} — early check-in / late check-out not possible`);
  }
  return lines.join('\n');
}

// ─── Email notifications ───────────────────────────────────────────────────

async function sendEmailNotification(subject, body) {
  if (!process.env.NOTIFICATION_EMAIL || !process.env.SENDGRID_API_KEY) return;
  try {
    await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: process.env.NOTIFICATION_EMAIL }] }],
      from: { email: 'autopilot@premiumrentals.ai', name: 'Autopilot by Premium Rentals' },
      subject,
      content: [{ type: 'text/plain', value: body }]
    }, { headers: { 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' } });
  } catch (err) { console.error('Email notification failed:', err.message); }
}

// ─── Core AI reply generator (shared by Guesty + Podium) ──────────────────

async function generateAIReply(listingId, guestName, guestMessage, reservationContext, settings) {
  const { data: listing } = await supabase.from('listings').select('*').eq('id', listingId).single().catch(() => ({ data: null }));
  const { data: knowledge } = await supabase.from('listing_knowledge').select('*').eq('listing_id', listingId).catch(() => ({ data: [] }));
  const { data: goodExamples } = await supabase.from('sent_log')
    .select('body, guest_message').eq('listing_id', listingId).eq('thumbs_up', true).limit(5);
  const examplesText = goodExamples?.length
    ? `\nGOOD REPLY EXAMPLES:\n${goodExamples.map(e => `Guest: "${e.guest_message}"\nReply: "${e.body}"`).join('\n\n')}` : '';

  let calendarContext = '';
  if (listing?.id) {
    const today = new Date().toISOString().split('T')[0];
    const in60 = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
    const [calendar, reservations] = await Promise.all([
      getListingCalendar(listing.id, today, in60),
      getListingReservations(listing.id, today, in60)
    ]);
    calendarContext = formatCalendarContext(calendar, reservations);
  }

  const knowledgeText = (knowledge || []).map(k => `${k.label}: ${k.value}`).join('\n');
  const listingContext = listing ? `
Property: ${listing.nickname} — ${listing.title}
Address: ${listing.address}
Door code: ${reservationContext?.door_code || listing.door_code || 'not set'}
WiFi: ${listing.wifi_name} / ${listing.wifi_password}
Check-in: ${listing.check_in_time} | Check-out: ${listing.check_out_time}
Bedrooms: ${listing.bedrooms} | Bathrooms: ${listing.bathrooms} | Sleeps: ${listing.accommodates}
Parking: ${listing.parking || 'not set'}
Min nights: ${listing.min_nights} | Max nights: ${listing.max_nights}
Cleaning fee: $${listing.cleaning_fee} | Pet fee: $${listing.pet_fee}
Amenities: ${listing.amenities || 'not set'}
House rules: ${listing.description_house_rules || 'not set'}
Special notes: ${listing.special_notes || 'none'}
${knowledgeText ? `Additional info:\n${knowledgeText}` : ''}
${examplesText}` : 'Property info not available.';

  const reservationText = reservationContext
    ? `Guest: ${guestName} | Platform: ${reservationContext.platform || 'SMS'}
Confirmation: ${reservationContext.confirmation_code || 'N/A'} | Guests: ${reservationContext.guests_count || 'unknown'}
Check-in: ${reservationContext.check_in} | Check-out: ${reservationContext.check_out}`
    : `Guest: ${guestName} | No active reservation found`;

  const systemPrompt = `${settings?.system_prompt || 'You are a professional short-term rental host assistant for Autopilot by Premium Rentals.'}
Tone: ${settings?.reply_tone || 'friendly'}

PROPERTY KNOWLEDGE BASE:
${listingContext}

GUEST RESERVATION:
${reservationText}

${calendarContext}

CRITICAL INSTRUCTIONS:
- Use calendar context to accurately answer availability, early check-in, late check-out, and extra night requests
- If same-day turnover exists, politely decline early check-in or late check-out
- If guest asks if they are talking to AI, a bot, or a real person — set suspectsAI to true
- Always address guest by first name
- Be warm, helpful, and professional
- Keep replies concise — this may be SMS

Respond ONLY with a JSON object — no markdown:
{"reply": "your reply here", "confidence": 0-100, "reasoning": "brief reason", "suspectsAI": false}`;

  const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Guest message: "${guestMessage}"` }]
  }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

  const raw = aiRes.data.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ─── Base ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Autopilot by Premium Rentals' }));

// ─── Listings ──────────────────────────────────────────────────────────────

app.post('/api/listings/sync', async (req, res) => {
  try {
    let allListings = [], skip = 0;
    const limit = 25;
    while (true) {
      const data = await guestyRequest('GET', `/listings?limit=${limit}&skip=${skip}`);
      const results = data?.results || data?.data || (Array.isArray(data) ? data : []);
      allListings = allListings.concat(results);
      if (results.length < limit) break;
      skip += limit;
    }
    const rows = allListings.map(l => ({
      id: l._id, nickname: l.nickname || l.title, title: l.title,
      address: l.address?.full || [l.address?.street, l.address?.city, l.address?.state, l.address?.zipcode].filter(Boolean).join(', '),
      city: l.address?.city || null, state: l.address?.state || null, zipcode: l.address?.zipcode || null,
      lat: l.address?.lat || null, lng: l.address?.lng || null, timezone: l.timezone || null,
      listing_type: l.propertyType || 'SINGLE', room_type: l.roomType || null,
      picture_url: l.picture?.thumbnail || l.pictures?.[0]?.thumbnail || null,
      bedrooms: l.bedrooms || null, bathrooms: l.bathrooms || null, beds: l.beds || null,
      accommodates: l.accommodates || null, area_sq_ft: l.areaSquareFeet || null,
      check_in_time: l.defaultCheckInTime || null, check_out_time: l.defaultCheckOutTime || null,
      wifi_name: l.wifiName || null, wifi_password: l.wifiPassword || null,
      base_price: l.prices?.basePrice || null, cleaning_fee: l.prices?.cleaningFee || null,
      pet_fee: l.prices?.petFee || null, security_deposit: l.prices?.securityDepositFee || null,
      min_nights: l.terms?.minNights || null, max_nights: l.terms?.maxNights || null,
      description_summary: l.publicDescription?.summary || null, description_access: l.publicDescription?.access || null,
      description_house_rules: l.publicDescription?.houseRules || null, description_neighborhood: l.publicDescription?.neighborhood || null,
      amenities: l.amenities?.length ? l.amenities.join(', ') : null,
      tags: l.tags?.length ? l.tags.join(', ') : null, is_listed: l.isListed ?? true, active: l.active ?? true,
    }));
    const { error } = await supabase.from('listings').upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
    if (error) throw error;
    res.json({ success: true, synced: rows.length });
  } catch (err) { console.error('Listings sync error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/listings', async (req, res) => {
  try {
    const { data: listings, error } = await supabase.from('listings').select('*').order('nickname');
    if (error) throw error;
    const { data: knowledge } = await supabase.from('listing_knowledge').select('*');
    res.json(listings.map(l => ({ ...l, extras: (knowledge || []).filter(k => k.listing_id === l.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/listings/:id', async (req, res) => {
  try {
    const { extras, ...fields } = req.body;
    const { error } = await supabase.from('listings').update(fields).eq('id', req.params.id);
    if (error) throw error;
    if (extras !== undefined) {
      await supabase.from('listing_knowledge').delete().eq('listing_id', req.params.id);
      if (extras.length > 0) await supabase.from('listing_knowledge').insert(extras.map(e => ({ listing_id: req.params.id, label: e.label, value: e.value })));
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/listings/:id/calendar', async (req, res) => {
  try {
    const { from, to } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const in60 = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
    const [calendar, reservations] = await Promise.all([
      getListingCalendar(req.params.id, from || today, to || in60),
      getListingReservations(req.params.id, from || today, to || in60)
    ]);
    res.json({ calendar, reservations });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/listings/:id/availability', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });
    const dayBefore = new Date(new Date(date).getTime() - 86400000).toISOString().split('T')[0];
    const dayAfter = new Date(new Date(date).getTime() + 86400000).toISOString().split('T')[0];
    const in3 = new Date(new Date(date).getTime() + 3 * 86400000).toISOString().split('T')[0];
    const [calendar, reservations] = await Promise.all([
      getListingCalendar(req.params.id, dayBefore, in3),
      getListingReservations(req.params.id, dayBefore, in3)
    ]);
    const dayData = calendar.find(d => d.date === date);
    const prevDay = calendar.find(d => d.date === dayBefore);
    const nextDay = calendar.find(d => d.date === dayAfter);
    const hasCheckoutBefore = reservations.some(r => new Date(r.checkOut).toISOString().split('T')[0] === date);
    const hasCheckinAfter = reservations.some(r => new Date(r.checkIn).toISOString().split('T')[0] === dayAfter);
    res.json({
      date, available: dayData?.status === 'available', price: dayData?.price, minNights: dayData?.minNights,
      sameDayTurnover: hasCheckoutBefore && hasCheckinAfter,
      previousNightBooked: prevDay?.status !== 'available', nextNightBooked: nextDay?.status !== 'available',
      earlyCheckinPossible: !hasCheckoutBefore, lateCheckoutPossible: !hasCheckinAfter,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Conversations ─────────────────────────────────────────────────────────

app.post('/api/conversations/sync', async (req, res) => {
  try {
    const data = await guestyRequest('GET', `/reservations?limit=25&sort=-createdAt`);
    const reservations = data?.results || [];
    let synced = 0;
    for (const r of reservations) {
      const full = await guestyRequest('GET', `/reservations/${r._id}`).catch(() => null);
      if (!full) continue;
      const guestName = full.guest?.fullName || [full.guest?.firstName, full.guest?.lastName].filter(Boolean).join(' ') || 'Guest';
      let guestyStatus = 'open';
      try {
        const convData = await guestyRequest('GET', `/conversations?reservationId=${full._id}&limit=1`);
        const conv = convData?.results?.[0] || convData?.[0];
        if (conv) {
          const raw = (conv.status || conv.conversationStatus || '').toLowerCase();
          guestyStatus = ['archived', 'closed', 'resolved'].includes(raw) ? 'archived' : 'open';
        }
      } catch (e) { console.log(`Could not fetch conversation status for ${full._id}:`, e.message); }

      await supabase.from('conversations').upsert({
        id: full._id, listing_id: full.listingId, reservation_id: full._id,
        guest_name: guestName, guest_email: full.guest?.email,
        guest_phone: normalizePhone(full.guest?.phone || full.guest?.phones?.[0]?.number || ''),
        platform: full.source || 'Direct', check_in: full.checkIn, check_out: full.checkOut,
        door_code: full.keyCode || full.notes?.guest || null,
        confirmation_code: full.confirmationCode || null, guests_count: full.guestsCount || null,
        status: 'pending', source: 'guesty', guesty_status: guestyStatus,
      }, { onConflict: 'id' });
      synced++;
    }
    res.json({ success: true, synced });
  } catch (err) { console.error('Conversations sync error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/inbox', async (req, res) => {
  try {
    const showArchived = req.query.archived === 'true';
    let query = supabase.from('conversations').select('*, listings(*)').order('check_in', { ascending: true });
    if (showArchived) {
      query = query.eq('guesty_status', 'archived');
    } else {
      query = query.not('status', 'eq', 'replied').or('guesty_status.is.null,guesty_status.eq.open');
    }
    const { data: convos, error } = await query;
    if (error) throw error;
    const result = [];
    for (const c of convos) {
      const { data: msgs } = await supabase.from('messages').select('*')
        .eq('conversation_id', c.id).order('created_at', { ascending: false }).limit(10);
      const lastInbound = (msgs || []).find(m => m.direction === 'inbound');
      result.push({ ...c, lastMessage: lastInbound || null, messages: msgs || [] });
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/conversations/:id/snooze', async (req, res) => {
  try {
    const { hours, reason } = req.body;
    const snoozed_until = hours ? new Date(Date.now() + hours * 3600000).toISOString() : null;
    await supabase.from('conversations').update({ snoozed: true, snoozed_until, snooze_reason: reason || 'manual' }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/conversations/:id/unsnooze', async (req, res) => {
  try {
    await supabase.from('conversations').update({ snoozed: false, snoozed_until: null, snooze_reason: null }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/conversations/:id/archive', async (req, res) => {
  try {
    await supabase.from('conversations').update({ guesty_status: 'archived' }).eq('id', req.params.id);
    try {
      const convData = await guestyRequest('GET', `/conversations?reservationId=${req.params.id}&limit=1`);
      const conv = convData?.results?.[0] || convData?.[0];
      if (conv?._id) await guestyRequest('PUT', `/conversations/${conv._id}`, { status: 'archived' });
    } catch (e) { console.log('Guesty archive sync skipped:', e.message); }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/conversations/:id/unarchive', async (req, res) => {
  try {
    await supabase.from('conversations').update({ guesty_status: 'open' }).eq('id', req.params.id);
    try {
      const convData = await guestyRequest('GET', `/conversations?reservationId=${req.params.id}&limit=1`);
      const conv = convData?.results?.[0] || convData?.[0];
      if (conv?._id) await guestyRequest('PUT', `/conversations/${conv._id}`, { status: 'open' });
    } catch (e) { console.log('Guesty unarchive sync skipped:', e.message); }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── AI Reply (Guesty) ─────────────────────────────────────────────────────

app.post('/api/generate-reply', async (req, res) => {
  try {
    const { conversationId, messageId } = req.body;
    const { data: convo } = await supabase.from('conversations').select('*, listings(*)').eq('id', conversationId).single();
    const { data: msg } = await supabase.from('messages').select('*').eq('id', messageId).single();
    const { data: settings } = await supabase.from('settings').select('*').eq('id', 1).single();
    const { data: listing_settings } = await supabase.from('listing_autopilot').select('*').eq('listing_id', convo.listing_id).single().catch(() => ({ data: null }));
    if (listing_settings?.autopilot_enabled === false) return res.json({ reply: null, confidence: 0, reasoning: 'Autopilot disabled', autoSent: false });

    const parsed = await generateAIReply(convo.listing_id, convo.guest_name, msg.body, {
      door_code: convo.door_code, confirmation_code: convo.confirmation_code,
      guests_count: convo.guests_count, check_in: convo.check_in, check_out: convo.check_out, platform: convo.platform,
    }, settings);

    await supabase.from('messages').update({ ai_draft: parsed.reply, ai_confidence: parsed.confidence, ai_reasoning: parsed.reasoning }).eq('id', messageId);

    if (parsed.suspectsAI) {
      await supabase.from('conversations').update({ snoozed: true, snoozed_until: null, snooze_reason: 'ai_suspicion' }).eq('id', conversationId);
      await sendEmailNotification(`⚠️ Guest suspects AI — ${convo.guest_name}`, `Guest ${convo.guest_name} at ${convo.listings?.nickname} may suspect AI.\n\nMessage: "${msg.body}"\n\nSnoozed for review.`);
      return res.json({ reply: parsed.reply, confidence: parsed.confidence, reasoning: parsed.reasoning, autoSent: false, snoozed: true });
    }

    const threshold = settings?.confidence_threshold || 85;
    const autoSent = settings?.auto_send_enabled && parsed.confidence >= threshold;
    if (autoSent) {
      await sendGuestyReply(conversationId, messageId, parsed.reply, true, parsed.confidence, convo, convo.listings, msg.body);
    } else {
      await sendEmailNotification(`📬 Message needs review — ${convo.guest_name}`, `Guest ${convo.guest_name} at ${convo.listings?.nickname}.\n\nMessage: "${msg.body}"\n\nDraft (${parsed.confidence}%): "${parsed.reply}"\n\nhttps://premiumrentals.ai`);
    }
    res.json({ reply: parsed.reply, confidence: parsed.confidence, reasoning: parsed.reasoning, autoSent });
  } catch (err) { console.error('Generate reply error:', err.message); res.status(500).json({ error: err.message }); }
});

async function sendGuestyReply(conversationId, messageId, body, autoSent, confidence, convo, listing, guestMessage) {
  await guestyRequest('POST', `/conversations/${conversationId}/messages`, { body, type: 'host' });
  await supabase.from('messages').update({ sent_at: new Date().toISOString(), auto_sent: autoSent }).eq('id', messageId);
  await supabase.from('conversations').update({ status: 'replied' }).eq('id', conversationId);
  await supabase.from('sent_log').insert({ message_id: messageId, conversation_id: conversationId, listing_id: convo?.listing_id, guest_name: convo?.guest_name, body, guest_message: guestMessage || null, auto_sent: autoSent, confidence, channel: 'guesty' });
}

app.post('/api/send-reply', async (req, res) => {
  try {
    const { conversationId, messageId, body } = req.body;
    const { data: convo } = await supabase.from('conversations').select('*, listings(*)').eq('id', conversationId).single();
    const { data: msg } = await supabase.from('messages').select('*').eq('id', messageId).single();
    if (convo?.source === 'podium') {
      await sendPodiumReply(convo.podium_conversation_id, body);
      await supabase.from('messages').update({ sent_at: new Date().toISOString(), auto_sent: false }).eq('id', messageId);
      await supabase.from('conversations').update({ status: 'replied' }).eq('id', conversationId);
      await supabase.from('sent_log').insert({ message_id: messageId, conversation_id: conversationId, listing_id: convo?.listing_id, guest_name: convo?.guest_name, body, guest_message: msg?.body, auto_sent: false, confidence: null, channel: 'podium' });
    } else {
      await sendGuestyReply(conversationId, messageId, body, false, null, convo, convo?.listings, msg?.body);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/sent-log/:id/feedback', async (req, res) => {
  try {
    const { thumbs_up } = req.body;
    await supabase.from('sent_log').update({ thumbs_up }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Podium webhook ────────────────────────────────────────────────────────

app.post('/webhook/podium', async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    console.log('Podium webhook:', JSON.stringify(event).slice(0, 300));

    const messageBody = event.body || event.message?.body || event.content || '';
    const fromPhone = event.customer?.phoneNumber || event.from || event.phoneNumber || event.contact?.phoneNumber || '';
    const podiumConvId = event.conversationUid || event.conversation?.uid || event.conversationId || event.uid || '';
    const customerName = event.customer?.name || event.contact?.name || event.name || 'Guest';
    const direction = event.direction || event.type || '';

    if (!messageBody || !fromPhone) { console.log('Podium webhook: missing body or phone'); return; }
    if (['outbound', 'sent', 'fromBusiness'].includes(direction)) { console.log('Podium webhook: outbound, skipping'); return; }

    const normalized = normalizePhone(fromPhone);
    if (normalized && podiumConvId) {
      await supabase.from('podium_contacts').upsert({ phone: normalized, podium_conversation_id: podiumConvId, updated_at: new Date().toISOString() }, { onConflict: 'phone' });
    }

    const guestContact = await matchPodiumGuestToGuesty(fromPhone);
    const convId = `podium_${podiumConvId || normalized}`;
    const guestName = guestContact?.guest_name || customerName;

    await supabase.from('conversations').upsert({
      id: convId, source: 'podium', podium_conversation_id: podiumConvId,
      guest_name: guestName, guest_phone: normalized, guest_email: guestContact?.guest_email || null,
      listing_id: guestContact?.listing_id || null, reservation_id: guestContact?.reservation_id || null,
      platform: 'SMS / Podium', check_in: guestContact?.check_in || null, check_out: guestContact?.check_out || null,
      door_code: guestContact?.door_code || null, confirmation_code: guestContact?.confirmation_code || null,
      guests_count: guestContact?.guests_count || null, status: 'pending', guesty_status: 'open',
    }, { onConflict: 'id' });

    const msgId = `podium_msg_${podiumConvId}_${Date.now()}`;
    await supabase.from('messages').upsert({ id: msgId, conversation_id: convId, direction: 'inbound', body: messageBody, created_at: new Date().toISOString() }, { onConflict: 'id', ignoreDuplicates: true });

    if (!guestContact?.listing_id) {
      console.log(`Podium: no listing match for ${fromPhone}, queuing for review`);
      await sendEmailNotification(`📱 Podium SMS — unknown guest ${fromPhone}`, `SMS from ${fromPhone} — no Guesty match.\n\nMessage: "${messageBody}"\n\nhttps://premiumrentals.ai`);
      return;
    }

    const { data: listing_settings } = await supabase.from('listing_autopilot').select('*').eq('listing_id', guestContact.listing_id).single().catch(() => ({ data: null }));
    if (listing_settings?.autopilot_enabled === false) { console.log(`Podium: autopilot disabled for ${guestContact.listing_id}`); return; }

    const { data: settings } = await supabase.from('settings').select('*').eq('id', 1).single();
    const parsed = await generateAIReply(guestContact.listing_id, guestName, messageBody, guestContact, settings);
    await supabase.from('messages').update({ ai_draft: parsed.reply, ai_confidence: parsed.confidence, ai_reasoning: parsed.reasoning }).eq('id', msgId);

    if (parsed.suspectsAI) {
      await supabase.from('conversations').update({ snoozed: true, snoozed_until: null, snooze_reason: 'ai_suspicion' }).eq('id', convId);
      await sendEmailNotification(`⚠️ Podium guest suspects AI — ${guestName}`, `Guest ${guestName} (${fromPhone}) may suspect AI.\n\nMessage: "${messageBody}"`);
      return;
    }

    const threshold = settings?.confidence_threshold || 85;
    const autoSend = settings?.auto_send_enabled && parsed.confidence >= threshold;
    if (autoSend && podiumConvId) {
      await sendPodiumReply(podiumConvId, parsed.reply);
      await supabase.from('messages').update({ sent_at: new Date().toISOString(), auto_sent: true }).eq('id', msgId);
      await supabase.from('conversations').update({ status: 'replied' }).eq('id', convId);
      await supabase.from('sent_log').insert({ message_id: msgId, conversation_id: convId, listing_id: guestContact.listing_id, guest_name: guestName, body: parsed.reply, guest_message: messageBody, auto_sent: true, confidence: parsed.confidence, channel: 'podium' });
      console.log(`Podium: auto-sent to ${fromPhone} (${parsed.confidence}%)`);
    } else {
      await sendEmailNotification(`📱 Podium SMS needs review — ${guestName}`, `Guest ${guestName} (${fromPhone}).\n\nMessage: "${messageBody}"\n\nDraft (${parsed.confidence}%): "${parsed.reply}"\n\nhttps://premiumrentals.ai`);
    }
  } catch (err) { console.error('Podium webhook error:', err.message); }
});

// ─── Guesty webhook ────────────────────────────────────────────────────────

app.post('/webhook/guesty', async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    console.log('Guesty webhook:', event.event);
    if (!['reservation.messageReceived', 'conversation.message.created'].includes(event.event)) return;
    const reservationId = event.reservationId;
    const conversation = event.conversation;
    const message = event.message;
    if (!conversation || !message) return;
    if (message.type === 'fromHost') return;
    const convId = conversation._id;
    const guestName = conversation.meta?.guestName || 'Guest';
    const reservationMeta = conversation.meta?.reservations?.[0];
    const reservation = reservationId ? await guestyRequest('GET', `/reservations/${reservationId}`).catch(() => null) : null;
    await supabase.from('conversations').upsert({
      id: convId, listing_id: reservation?.listingId, reservation_id: reservationId || null,
      guest_name: guestName, guest_email: reservation?.guest?.email,
      guest_phone: normalizePhone(reservation?.guest?.phone || reservation?.guest?.phones?.[0]?.number || ''),
      platform: reservation?.source || 'Direct',
      check_in: reservationMeta?.checkIn || reservation?.checkIn, check_out: reservationMeta?.checkOut || reservation?.checkOut,
      door_code: reservation?.keyCode || reservation?.notes?.guest || null,
      confirmation_code: reservationMeta?.confirmationCode || reservation?.confirmationCode || null,
      guests_count: reservation?.guestsCount || null, status: 'pending', source: 'guesty', guesty_status: 'open',
    }, { onConflict: 'id' });
    const msgId = message._id || message.postId;
    await supabase.from('messages').upsert({ id: msgId, conversation_id: convId, direction: 'inbound', body: message.body || '', created_at: message.createdAt }, { onConflict: 'id', ignoreDuplicates: true });
    await axios.post(`${process.env.API_URL}/api/generate-reply`, { conversationId: convId, messageId: msgId });
  } catch (err) { console.error('Guesty webhook error:', err.message); }
});

// ─── Playground ────────────────────────────────────────────────────────────

app.post('/api/playground', async (req, res) => {
  try {
    const { message, listingId } = req.body;
    const { data: settings } = await supabase.from('settings').select('*').eq('id', 1).single();
    let listingContext = '', calendarContext = '';
    if (listingId) {
      const { data: listing } = await supabase.from('listings').select('*').eq('id', listingId).single();
      if (listing) {
        listingContext = `Property: ${listing.nickname}, WiFi: ${listing.wifi_name}/${listing.wifi_password}, Check-in: ${listing.check_in_time}, Check-out: ${listing.check_out_time}, Door: ${listing.door_code || 'not set'}, Sleeps: ${listing.accommodates}, Min nights: ${listing.min_nights}`;
        const today = new Date().toISOString().split('T')[0];
        const in60 = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
        const [cal, r] = await Promise.all([getListingCalendar(listingId, today, in60), getListingReservations(listingId, today, in60)]);
        calendarContext = formatCalendarContext(cal, r);
      }
    }
    const systemPrompt = `${settings?.system_prompt || 'You are a professional short-term rental host assistant for Premium Rentals.'}
Tone: ${settings?.reply_tone || 'friendly'}
${listingContext ? `Property: ${listingContext}` : ''}
${calendarContext ? `\n${calendarContext}` : ''}
Keep replies under 150 words.
Respond ONLY with a JSON object: {"reply": "your reply", "confidence": 0-100, "suspectsAI": false}`;
    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514', max_tokens: 400, system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    const raw = aiRes.data.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    res.json({ reply: parsed.reply, confidence: parsed.confidence, suspectsAI: parsed.suspectsAI });
  } catch (err) { console.error('Playground error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/message-categories', async (req, res) => {
  try {
    const { data: messages } = await supabase.from('messages').select('body, direction').eq('direction', 'inbound').limit(100);
    if (!messages || messages.length === 0) return res.json([]);
    const sample = messages.slice(0, 50).map(m => m.body).join('\n---\n');
    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514', max_tokens: 600,
      system: 'Analyze short-term rental guest messages. Return ONLY a JSON array, no markdown: [{"label": "category", "count": number}]. Categories: Check-in questions, WiFi & amenities, Late checkout requests, Early check-in requests, Maintenance issues, Booking inquiries, Availability questions, Payment questions, General courtesy, Other.',
      messages: [{ role: 'user', content: `Categorize these ${messages.length} messages:\n\n${sample}` }]
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    const raw = aiRes.data.content[0].text.replace(/```json|```/g, '').trim();
    const categories = JSON.parse(raw);
    const total = categories.reduce((a, b) => a + b.count, 0);
    res.json(categories.map(c => ({ label: c.label, count: c.count, pct: Math.round(c.count / total * 100) })).sort((a, b) => b.pct - a.pct));
  } catch (err) { console.error('Categories error:', err.message); res.json([]); }
});

app.get('/api/listing-autopilot', async (req, res) => {
  const { data } = await supabase.from('listing_autopilot').select('*');
  res.json(data || []);
});

app.patch('/api/listing-autopilot/:listingId', async (req, res) => {
  try {
    const { autopilot_enabled } = req.body;
    await supabase.from('listing_autopilot').upsert({ listing_id: req.params.listingId, autopilot_enabled }, { onConflict: 'listing_id' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/podium-contacts', async (req, res) => {
  try {
    const { data } = await supabase.from('podium_contacts').select('*').order('updated_at', { ascending: false }).limit(100);
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings', async (req, res) => {
  const { data } = await supabase.from('settings').select('confidence_threshold, reply_tone, auto_send_enabled, system_prompt, notification_email').eq('id', 1).single();
  res.json(data);
});

app.patch('/api/settings', async (req, res) => {
  const { error } = await supabase.from('settings').update(req.body).eq('id', 1);
  res.json({ success: !error, error: error?.message });
});

app.get('/api/sent-log', async (req, res) => {
  const { data } = await supabase.from('sent_log').select('*').order('sent_at', { ascending: false }).limit(100);
  res.json(data || []);
});

// ─── Debug ─────────────────────────────────────────────────────────────────

app.get('/api/debug-conversations', async (req, res) => {
  try {
    const data = await guestyRequest('GET', `/reservations?limit=1&sort=-createdAt`);
    const r = data?.results?.[0];
    if (!r) return res.json({ error: 'No reservations found' });
    const full = await guestyRequest('GET', `/reservations/${r._id}`);
    res.json({ topLevelKeys: Object.keys(full), guestName: full.guest?.fullName, guestPhone: full.guest?.phone, guestPhones: full.guest?.phones, keyCode: full.keyCode, source: full.source, checkIn: full.checkIn, checkOut: full.checkOut });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug-podium-match/:phone', async (req, res) => {
  try {
    const result = await matchPodiumGuestToGuesty(req.params.phone);
    res.json({ matched: !!result, contact: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Autopilot by Premium Rentals — port ${PORT}`));
