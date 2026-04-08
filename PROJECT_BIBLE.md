# Premium Rentals — Project Bible

Last updated: April 2026

---

## 1. Overview

**premiumrentals.com** is a vacation rental website for a luxury short-term rental company in the Boise/McCall, Idaho area. It lists multiple properties, shows availability and live pricing from Guesty, and handles the full booking flow including Stripe payments.

There is also an admin portal (`/admin`) that allows staff to create custom price quotes and send them directly to guests via shareable links.

---

## 2. Infrastructure

| Layer | Service | Notes |
|---|---|---|
| Frontend | **Vercel** | Static HTML/JS/CSS; no build step |
| Backend API | **Railway** | Node.js/Express server (`server.js`) |
| Database | **Supabase** | Postgres; stores quotes, contacts, pricing cache |
| Payments | **Stripe** | Cards via SetupIntent; ACH via `us_bank_account` |
| PMS | **Guesty** | Property management system; source of truth for listings, calendar, pricing, reservations |

**Domains:**
- `premiumrentals.com` — primary live domain
- `premiumrentals.homes` — secondary/redirect

**Deployment:**
- Push to `main` branch → Railway auto-deploys backend in ~1-2 min
- Push to `main` branch → Vercel auto-deploys frontend instantly

---

## 3. File Structure

```
PremiumRentalsMAINSITE/
├── server.js           ← Railway backend (all API routes)
├── package.json        ← Node dependencies
├── vercel.json         ← Vercel routing, redirects, headers
│
├── index.html          ← Homepage
├── properties.html     ← All properties listing page
├── property.html       ← Single property page (calendar, pricing, booking widget)
├── checkout.html       ← Payment/booking form (shared by main site + admin quotes)
├── confirmation.html   ← Post-booking confirmation page
├── quote.html          ← Guest-facing quote page (admin quote links)
├── admin.html          ← Admin portal (password protected)
│
├── cancellation.html   ← Cancellation policy page
├── terms.html          ← Terms of service
├── privacy.html        ← Privacy policy
├── owners.html         ← Owner inquiry/contact page
└── 404.html            ← Custom 404
```

---

## 4. Environment Variables (Railway)

| Variable | Purpose |
|---|---|
| `GUESTY_CLIENT_ID` | Open API (OAPI) OAuth client ID |
| `GUESTY_CLIENT_SECRET` | Open API (OAPI) OAuth client secret |
| `GUESTY_BE_CLIENT_ID` | Booking Engine API (BE-API) OAuth client ID |
| `GUESTY_BE_CLIENT_SECRET` | Booking Engine API (BE-API) OAuth client secret |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (also hardcoded in HTML) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (bypasses RLS) |
| `ADMIN_PASSWORD` | Password for the admin portal login |
| `SYNC_SECRET` | Header secret for `/api/website/sync-pricing` |
| `SERVICE_FEE_RATE` | Fallback service fee rate (default: 0.135 = 13.5%) |
| `TOURISM_TAX_RATE` | Tourism/lodging tax rate (default: 0.02 = 2%) |
| `SALES_TAX_RATE` | Sales tax rate (default: 0.06 = 6%) |

> **Tax note:** Tax rates in env vars are used only in the fallback BE-API pricing path. The main website uses Guesty's V3 quote taxes directly. Admin quotes use a hardcoded 8% (flat) applied to accommodation + cleaning + service fee.

---

## 5. Guesty API Usage

### Two separate APIs, two separate tokens

**Open API (OAPI)** — `https://open-api.guesty.com`
- Token endpoint: `POST /oauth2/token` with `scope: open-api`
- Used for: V3 quotes, reservations, guest updates, payment recording, invoice items, availability
- Token cached in memory, refreshed before expiry

**Booking Engine API (BE-API)** — `https://booking.guesty.com`
- Token endpoint: `POST /oauth2/token` with `scope: booking_engine:api`
- Used for: listings list, calendar availability
- Token cached in memory

### Key Guesty endpoints used

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/listings` | GET | All listings (Open API) |
| `/booking.guesty.com/api/listings` | GET | Listings with BE-API (richer data) |
| `/v1/quotes` | POST | Create V3 quote for pricing/availability |
| `/v1/quotes/:id/coupons` | POST | Apply coupon to quote |
| `/v1/reservations-v3/quote` | POST | Create V3 reservation from quote (main site) |
| `/v1/reservations` | POST/PUT | Create or update V1 reservation (admin quotes) |
| `/v1/guests/:id` | PUT | Update guest contact info |
| `/v1/guests/:id/payment-methods` | POST | Attach card to guest |
| `/v1/payment-providers/provider-by-listing` | GET | Get Stripe payment provider ID |
| `/v1/invoice-items/reservation/:id` | POST | Add invoice line item to reservation |
| `/v1/reservations/:id/payments` | POST | Record external payment (ACH) |
| `/v1/additional-fees/account` | GET | List account-level additional fees |
| `/booking.guesty.com/api/listings/:id/calendar` | GET | Calendar availability |

### Guesty API gotchas (hard-won knowledge)

**V1 reservations money fields:**
- Only `fareAccommodation` and `fareCleaning` are writable in `body.money`
- `fareServiceFee`, `fareManagementFee`, `fareTax` are **silently ignored** in V1
- `additionalFees` as a top-level body field is **rejected** with a validation error
- Service fee must be applied via `POST /v1/invoice-items/reservation/:id` after reservation creation

**Invoice items for service fee:**
```json
{
  "title": "Service Fee",
  "amount": 180.00,
  "normalType": "AFE",
  "secondIdentifier": "BOOKING_FEE"
}
```

**Recording ACH payment:**
```json
{
  "paymentMethod": { "method": "BANK_TRANSFER" },
  "amount": 1234.56,
  "paidAt": "2026-04-08T12:00:00.000Z",
  "note": "ACH bank transfer via Stripe — pi_xxx"
}
```
> `paymentMethod` must be a **nested object** with `method` inside — NOT a flat `type` field.

**Guest update (V1):**
- Use `phone: "+12085550100"` (flat string) — NOT `phones: [{ phone, isPrimary }]` array
- V3 reservation creation uses `phones: [formattedPhone]` array (different endpoint)

**Guesty sometimes returns plain text errors instead of JSON** — always `.text()` then try `JSON.parse()`. The `parseGuestyRes()` helper in server.js handles this.

**BOOKING_FEE additional fee:**
- Account-level fee: `_id: "69d5e6cbe896496781e1e689"`
- Type: `BOOKING_FEE`, `isPercentage: true`, value: 13.5%, `targetFee: PAYOUT`
- This auto-applies to reservations created via website (V3 flow)
- Does NOT auto-apply to V1 admin quote reservations — must add manually as invoice item

---

## 6. Supabase Tables

### `admin_quotes`
Stores all admin-created quotes. Never hard-deleted — status changes track history.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `guesty_reservation_id` | TEXT | Set when hold/reservation created in Guesty |
| `listing_id` | TEXT | Guesty listing `_id` |
| `listing_name` | TEXT | Display name |
| `listing_photo` | TEXT | Thumbnail URL |
| `guest_first_name` | TEXT | |
| `guest_last_name` | TEXT | |
| `guest_email` | TEXT | |
| `guest_phone` | TEXT | Raw as entered |
| `check_in` | DATE | `YYYY-MM-DD` |
| `check_out` | DATE | `YYYY-MM-DD` |
| `nights` | INT | |
| `custom_nightly_rate` | DECIMAL | Per-night rate (used to compute accommodation_total) |
| `accommodation_total` | DECIMAL | Total accommodation (rate × nights) |
| `cleaning_fee` | DECIMAL | Can be $0 — null means "not set" |
| `service_fee` | DECIMAL | |
| `taxes` | DECIMAL | 8% of (accommodation + cleaning + service fee) |
| `total` | DECIMAL | Sum of all above |
| `hold_type` | TEXT | `inquiry` or `reserved` |
| `hold_hours` | INT | Hours until reserved hold expires |
| `status` | TEXT | `pending`, `accepted`, `cancelled`, `expired` |
| `notes` | TEXT | Internal admin notes |
| `expires_at` | TIMESTAMPTZ | For reserved holds only |
| `accept_cards` | BOOL | Whether card payment is offered on quote |
| `accept_ach` | BOOL | Whether ACH payment is offered on quote |
| `created_at` | TIMESTAMPTZ | Auto |

**Status lifecycle:**
- `pending` → guest hasn't booked yet
- `accepted` → guest booked and paid
- `cancelled` → admin cancelled (Guesty reservation also cancelled)
- `expired` → check-out date passed (auto-set by server on each admin load)

### `website_contacts`
Captures contact form submissions and completed bookings.

| Column | Notes |
|---|---|
| `first_name`, `last_name`, `email` | |
| `interest` | e.g. `booking`, `inquiry` |
| `message` | Includes reservation details for bookings |

### `listing_pricing`
Cache table for Guesty base prices (synced daily).

| Column | Notes |
|---|---|
| `listing_id` | |
| `nightly_rate` | Base price from Guesty |
| `currency` | Always `USD` |
| `updated_at` | |

### `payment_settings`
Key-value table for site-wide payment method toggles.

| key | value |
|---|---|
| `accept_cards` | `"true"` or `"false"` |
| `accept_ach` | `"true"` or `"false"` |

---

## 7. Backend API Routes (server.js)

### Public — Website

| Route | Method | Description |
|---|---|---|
| `/api/website/listings` | GET | All active listings from BE-API (cached 5 min), enriched with Open API descriptions |
| `/api/website/availability/:listingId` | GET | Availability + full pricing from V3 quote (cached 30s). Params: `checkIn`, `checkOut`, `guests` |
| `/api/website/calendar/:listingId` | GET | Blocked/available dates from BE-API (cached 30s). Params: `startDate`, `endDate` |
| `/api/website/pricing` | GET | Base prices from Supabase cache |
| `/api/website/sync-pricing` | POST | Trigger Guesty→Supabase price sync (requires `x-sync-secret` header) |
| `/api/website/apply-coupon` | POST | Apply Guesty coupon code to a quote, return discount amount |
| `/api/website/create-setup-intent` | POST | Create Stripe SetupIntent for card or ACH. Body: `{ email, name, paymentType }` |
| `/api/website/reserve` | POST | Full main-site booking flow (V3 Guesty + Stripe card). Returns `reservationId`, `confirmationCode` |
| `/api/website/contact` | POST | Save contact form submission to Supabase |
| `/api/website/newsletter` | POST | Newsletter signup |
| `/api/payment-settings` | GET | Public: get current card/ACH enabled flags |

### Admin (requires `Authorization: Bearer <token>` header)

| Route | Method | Description |
|---|---|---|
| `/api/admin/login` | POST | Password login; returns 24h session token |
| `/api/admin/me` | GET | Verify session is valid |
| `/api/admin/listings` | GET | Listings for quote builder dropdown |
| `/api/admin/quotes` | GET | All quotes (auto-expires stale pending ones first) |
| `/api/admin/quotes` | POST | Create new quote + Guesty hold |
| `/api/admin/quotes/:id` | PUT | Update quote fields |
| `/api/admin/quotes/:id` | DELETE | Cancel quote (sets status=cancelled, cancels Guesty reservation) |
| `/api/admin/payment-settings` | GET/PUT | Manage card/ACH payment toggles |

### Public — Quote (guest-facing)

| Route | Method | Description |
|---|---|---|
| `/api/quote/:id` | GET | Get quote details for guest (strips internal fields) |
| `/api/quote/:id/reserve` | POST | Guest books a quote: Stripe charge + Guesty reservation confirm + invoice item + payment record |

---

## 8. Main Site Booking Flow

**Route:** `property.html` → `checkout.html` → `/api/website/reserve`

1. Guest selects dates on `property.html`
2. Server creates a **Guesty V3 quote** to get live pricing (BOOKING_FEE auto-applies at 13.5%)
3. Pricing displayed: accommodation, cleaning fee, service fee, taxes, total
4. Guest clicks Reserve → `checkout.html` opens with pricing in URL params
5. Card path: Stripe SetupIntent → `confirmCardSetup` → save PM
6. ACH path: **Not available on main site** (requires `acceptAch=1` URL param, which main site never sets)
7. `POST /api/website/reserve`: creates a strict V3 reservation, attaches Stripe PM to Guesty guest
8. Guesty charges the card through its own billing system
9. Guest lands on `confirmation.html`

**Important:** On the main site, Guesty handles billing automatically via the attached card. There is no explicit Stripe charge in our code — Guesty calls Stripe when it processes payment.

---

## 9. Admin Quote Flow

**Route:** `admin.html` → guest receives `quote.html` link → guest goes to `checkout.html` → `/api/quote/:id/reserve`

### Creating a quote (admin)

1. Admin fills form: property, dates, guest info, pricing
2. **Pricing fields:**
   - **Total Accommodation** — auto-filled as `nightlyAvg × nights` from Guesty; hint shows `/night avg`
   - **Cleaning Fee** — auto-filled from Guesty
   - **Service Fee** — auto-filled from Guesty (proportional to accommodation)
   - **Taxes** — auto-calculated at **8% of (accommodation + cleaning + service fee)**, with cents
3. Admin chooses hold type: **Inquiry** (dates not blocked) or **Reserved** (dates blocked, hold expires after N hours)
4. Admin enables/disables Card and ACH payment options per quote
5. On submit: saves to Supabase `admin_quotes`, creates Guesty reservation as `inquiry` or `reserved` status via V1 API
6. Admin copies the shareable link and sends to guest

### Guest checkout from quote

Step-by-step in `POST /api/quote/:id/reserve`:

1. **Retrieve PM from Stripe** — determine if card or ACH; get `pm.customer` for mandate
2. **Stripe customer** — use `pm.customer` if available; else look up or create by email
3. **ACH 4-day check** — check-in must be ≥ 4 days from now for ACH (bank settlement time)
4. **ACH charge** — create Stripe PaymentIntent (`confirm: true`); accept `processing` or `succeeded` status
5. **Get Guesty payment provider** — for card path
6. **Confirm or create Guesty reservation:**
   - If quote has `guesty_reservation_id`: PUT to confirm hold + set `fareAccommodation` / `fareCleaning`
   - If no hold: POST new V1 reservation with same money fields
7. **Update guest info** — PUT `/v1/guests/:id` with `firstName, lastName, email, phone` (flat string, not array)
8. **Card path** — attach PM to Guesty guest so Guesty handles future billing
9. **Service fee invoice item** — POST `/v1/invoice-items/reservation/:id` with `normalType: AFE`, `secondIdentifier: BOOKING_FEE`
10. **ACH payment record** — POST `/v1/reservations/:id/payments` with `paymentMethod: { method: 'BANK_TRANSFER' }` and `amount: quote.total`
11. **Mark quote accepted** — update Supabase `admin_quotes.status = 'accepted'`

---

## 10. Pricing Calculation

### Main Site (V3 quote from Guesty)
Guesty calculates everything. `extractV3Pricing()` reads it in priority order:
1. V3 invoice items (`normalType: MF` or `SF`)
2. `subTotalPrice` delta vs accommodation + cleaning
3. Listing-level `prices.fees` service fee rate
4. Env var `SERVICE_FEE_RATE` fallback (13.5%)

Taxes come from `moneyData.totalTaxes` (Guesty's calculation).

### Admin Quotes
Tax is calculated in the admin UI as:
```
taxes = round((accommodation + cleaning + serviceFee) × 0.08, 2 decimal places)
```
This 8% flat rate was chosen to match Guesty's actual tax calculation on these properties.

The total displayed is always: `accommodation + cleaning + serviceFee + taxes`

---

## 11. Stripe Integration

### Card flow (both main site and admin quotes)
1. Create SetupIntent via `/api/website/create-setup-intent`
2. `stripe.confirmCardSetup()` in browser
3. Get confirmed `payment_method` ID
4. Send to backend reserve endpoint
5. Attach to Guesty guest — Guesty charges via its Stripe integration

### ACH flow (admin quotes only)
1. Guest clicks "Link Bank Account"
2. Create SetupIntent with `payment_method_types: ['us_bank_account']`
3. `stripe.collectBankAccountForSetup()` opens Stripe bank link modal
4. `stripe.confirmUsBankAccountSetup()` at checkout confirms the mandate
5. Backend creates `PaymentIntent` with `confirm: true` (on-session — guest is present)
6. Accept `processing` status (ACH settles in 1-3 business days)
7. Record payment in Guesty via `/v1/reservations/:id/payments` with `BANK_TRANSFER` method

### Key Stripe notes
- ACH `SetupIntent` must use `usage: 'off_session'` to save the mandate
- ACH `PaymentIntent` must NOT use `off_session: true` when guest is present at checkout
- Always use `pm.customer` (from `stripe.paymentMethods.retrieve()`) as the customer ID for ACH — ensures the correct mandate is found

---

## 12. Frontend Pages

### `property.html`
- Shows property photos, description, amenities, reviews
- Calendar with blocked dates from BE-API
- Booking widget: select dates → fetch V3 pricing → show breakdown → Reserve button
- Handles coupon codes (applies via `/api/website/apply-coupon`)
- Mobile-responsive with slide-up booking sheet

### `checkout.html`
- Shared by both main site bookings and admin quote bookings
- Detects which flow based on presence of `quoteId` URL param
- For admin quotes: shows ACH tab if `acceptAch=1`, hides card if `acceptCards=0`
- Pricing summary at top
- Guest info form (name, email, phone, guests)
- Payment form (card via Stripe Elements, or ACH via Stripe bank link)
- Step indicator during processing

### `quote.html`
- Guest-facing page for admin-created quotes
- Shows property, dates, pricing breakdown, hold type notice
- For inquiry quotes: shows "These dates are not exclusively held for you until the reservation is confirmed. If you have any questions before booking, please contact us."
- "Book Now" button links to `checkout.html` with quote params

### `admin.html`
- Password-protected portal (24h session stored in localStorage)
- **New Quote tab:** Create custom-priced quotes with hold options
  - Total Accommodation field (auto-filled from Guesty, shows avg $/night hint)
  - Taxes auto-calculate at 8% of subtotal
- **All Quotes tab:**
  - Active / Archive filter tabs
  - Each card has ▾ expand button showing full price breakdown
  - Active = pending + accepted; Archive = expired + cancelled
  - Quotes never deleted — permanent history
  - Auto-expires pending quotes with passed dates on page load

---

## 13. Known Limitations / Gotchas

1. **Guesty V1 money fields** — only `fareAccommodation` and `fareCleaning` are writable. All other money fields are silently ignored or cause validation errors. Service fee must go through invoice items.

2. **Service fee timing** — Guesty recalculates reservation totals asynchronously after invoice items are added. Recording the ACH payment immediately after adding the invoice item may see a stale (pre-fee) balance due. Solution: use `quote.total` directly for the payment amount.

3. **ACH 4-day minimum** — ACH bank debits take 3-5 business days to settle. Enforce 4-day minimum check-in. Guest cannot use ACH for near-term bookings.

4. **Guesty BOOKING_FEE** — the account-level additional fee (`_id: 69d5e6cbe896496781e1e689`) is set to auto-apply at 13.5% of payout for V3/website bookings. For V1 admin quote bookings, it does NOT auto-apply — must be added manually as an AFE invoice item.

5. **Phone format** — Guesty V1 guest update requires `phone: "+12085550100"` (flat string). V3 reservation creation uses `phones: [formattedPhone]` (string array). These are different fields on different endpoints.

6. **No ACH on main site** — ACH is only enabled for admin quotes. The main site checkout never shows ACH because `acceptAch=1` is never included in the URL when navigating from `property.html`.

7. **Admin session** — stored in `localStorage` as `pr_admin_token`. Sessions expire after 24 hours. Sessions are stored in a server-side in-memory Map (lost on Railway restarts, but Railway instances are generally stable).

8. **BE-API vs Open API listings** — BE-API (`booking.guesty.com`) has richer listing data for display but doesn't include `lat/lng` or full `publicDescription` sub-fields. These are fetched from Open API and merged in.

9. **Dead Guesty endpoints** (confirmed 404 as of 2025-2026):
   - `POST /v1/reservations/:id/additional-fees`
   - `POST /v1/finance/invoice-items`
   - `POST /v1/reservations/:id/invoice-items`
   - `GET/POST /v2/reservations/:id/fees`

---

## 14. Recent Changes History

| Date | Change |
|---|---|
| Apr 2026 | Total Accommodation field in admin quote builder (was Nightly Rate); avg/night shown as hint |
| Apr 2026 | Added Active/Archive filter tabs to All Quotes; expandable price breakdown per quote card |
| Apr 2026 | Tax auto-calculates at 8% of (accommodation + cleaning + service fee) with cents |
| Apr 2026 | ACH payment records exact `quote.total` in Guesty (not stale balance-due) |
| Apr 2026 | Service fee applied via `POST /v1/invoice-items/reservation/:id` (AFE/BOOKING_FEE) |
| Apr 2026 | Removed `additionalFees` from reservation body (Guesty rejects with validation error) |
| Apr 2026 | ACH PaymentIntent: removed `off_session`, use `pm.customer` instead of email lookup |
| Apr 2026 | Guest update uses `phone: string` not `phones: [{phone, isPrimary}]` array |
| Apr 2026 | Payment recording uses `paymentMethod: { method: 'BANK_TRANSFER' }` (nested object) |
| Apr 2026 | `parseGuestyRes` helper: use `.text()` + try `JSON.parse()` to handle plain-text Guesty errors |
| Apr 2026 | `buildMoneyV1` includes `fareCleaning: 0` (not just > 0) to prevent revert to $159 default |
| Apr 2026 | Auto-expire pending quotes with passed check-out dates on admin load |
| Apr 2026 | Inquiry quote verbiage: "These dates are not exclusively held for you until confirmed..." |
