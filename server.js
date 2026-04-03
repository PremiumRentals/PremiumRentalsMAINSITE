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

    // Try the calendar endpoint which we know works, and extract pricing from it
    const calRes = await fetch(
      `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/${listingId}?startDate=${checkIn}&endDate=${checkOut}&includeAllotment=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const calData = await calRes.json();
    console.log('Availability raw:', JSON.stringify(calData).slice(0, 500));

    const days = calData.data?.days || calData.days || [];
    
    // Check if any days are blocked (unavailable)
    const hasBlocked = days.some(d => {
      const isAvail = typeof d.allotment === 'number' ? d.allotment > 0 : d.status === 'available';
      return !isAvail;
    });

    // Extract pricing from first available day
    let nightlyRate = null;
    let cleaningFee = 0;
    const firstDay = days.find(d => {
      const isAvail = typeof d.allotment === 'number' ? d.allotment > 0 : d.status === 'available';
      return isAvail;
    });
    
    if (firstDay) {
      nightlyRate = firstDay.price || firstDay.prices?.nightlyRate || 
                   firstDay.money?.nightlyRate || firstDay.ratePlan?.price ||
                   firstDay.availabilityPricing?.pricing?.ratesOccupancyBased?.[1] || null;
      console.log('First day data:', JSON.stringify(firstDay));
    }

    const result = {
      available: !hasBlocked,
      days,
      price: { nightlyRate, cleaningFee },
      nightlyRate,
      raw: calData
    };

    setCache(cacheKey, result, 2 * 60 * 1000);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
