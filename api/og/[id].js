// Vercel serverless function: /api/og/[id]
// Serves property-specific OG meta tags for social sharing (iMessage, Facebook, WhatsApp, etc.)
// Real browsers get a JS redirect to the actual property page; crawlers see the OG tags.

const RAILWAY = 'https://premiumrentalsmainsite-production.up.railway.app';

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function handler(req, res) {
  const id = req.query.id;
  if (!id) { res.status(400).send('Missing id'); return; }

  // Fetch listing from Railway (cached, fast)
  let listing = null;
  try {
    const r    = await fetch(`${RAILWAY}/api/website/listings`);
    const data = await r.json();
    listing    = (data.listings || []).find(l => l._id === id);
  } catch (e) { /* use fallback values */ }

  const title   = listing?.title
    ? `${listing.title} — Premium Rentals`
    : 'Luxury Vacation Rental — Premium Rentals';
  const desc    = (listing?.publicDescription?.summary || 'Luxury short-term rental in Idaho. Book directly for the best rate.').slice(0, 200);
  const photo   = listing?.pictures?.[0]?.original
    || listing?.pictures?.[0]?.thumbnail
    || 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1200&q=80';
  const city    = [listing?.address?.city, listing?.address?.state].filter(Boolean).join(', ');
  const propUrl = `https://premiumrentals.com/property.html?id=${id}`;
  const shareUrl= `https://premiumrentals.com/property/${id}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  // Serve OG-rich HTML. Browsers get JS redirect instantly; crawlers see the meta tags.
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">

  <!-- Open Graph -->
  <meta property="og:type"        content="website">
  <meta property="og:site_name"   content="Premium Rentals">
  <meta property="og:title"       content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image"       content="${esc(photo)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height"content="800">
  <meta property="og:url"         content="${esc(shareUrl)}">

  <!-- Twitter / X -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image"       content="${esc(photo)}">

  <link rel="canonical" href="${esc(shareUrl)}">

  <!-- Redirect real browsers to the property page immediately -->
  <meta http-equiv="refresh" content="0;url=${esc(propUrl)}">
  <script>window.location.replace(${JSON.stringify(propUrl)});</script>
</head>
<body>
  <a href="${esc(propUrl)}">${esc(title)}${city ? ` in ${esc(city)}` : ''}</a>
</body>
</html>`);
}
