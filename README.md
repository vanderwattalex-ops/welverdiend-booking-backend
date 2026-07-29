# Welverdiend Accommodation — Booking Platform

Unified booking calendar for Unit 1 and Unit 2, syncing with Airbnb,
Booking.com and Lekkeslaap via iCal every 10 minutes, plus direct EFT
bookings with proof-of-payment upload — embeddable on your Squarespace site.

## How it fits together

```
Airbnb .ics ─┐
Booking.com .ics ─┼──► Cloud Scheduler (every 10 min) ──► Cloud Run backend ──► Firestore
Lekkeslaap .ics ─┘                                              │
                                                                  ▼
                                              Squarespace site (booking-widget.html
                                              embedded via Code Block/iframe)
                                                                  │
                                              guest submits booking + EFT proof
                                                                  ▼
                                              Cloud Storage (proof of payment)
                                                                  │
                                              admin-dashboard.html — you confirm/reject
                                                                  │
                                              confirmed bookings exported back out at
                                              /ical/unit1.ics and /ical/unit2.ics —
                                              paste those into Airbnb/Booking.com/
                                              Lekkeslaap as "import calendar" sources
```

This closes the loop both ways: external bookings block your direct
calendar, and direct EFT bookings block your Airbnb/Booking.com/Lekkeslaap
calendars too.

## Part 1 — Deploy the backend to Cloud Run

You said you have a GCP account already, so:

1. **Install the gcloud CLI** if you don't have it, then:
   ```
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

2. **Create a Cloud Storage bucket** for proof-of-payment uploads:
   ```
   gcloud storage buckets create gs://welverdiend-proof-of-payment --location=europe-west1
   ```
   (Keep it private — do not make it public. The admin dashboard reads files via short-lived signed URLs.)

3. **Enable Firestore** (Native mode) in the Cloud Console for your project, if not already on.

4. **Fill in your iCal source links, nightly rate, and extras** in
   `backend/config/units.js`:
   - Paste the Airbnb / Booking.com / Lekkeslaap export URLs for Unit 1 and
     Unit 2 once you have them.
   - Set `pricePerNight` for each unit to your real rate.
   - Edit the `extras` array to match what you actually want to offer —
     it currently has placeholders for cleaning, laundry, firewood, and a
     breakfast hamper. Add, remove, rename, or reprice any of them; the
     guest-facing total and the admin dashboard both read from this same
     list, so you only edit prices in one place.
   - Unit photos live in `backend/public/` and are referenced from
     `units.js` as `/assets/filename.jpg` — drop a new image in that
     folder and point a unit's `photo` field at it (e.g. once you send a
     Unit 1 photo, save it as `backend/public/unit1-exterior.jpg` and set
     `photo: "/assets/unit1-exterior.jpg"`). No extra deploy step needed —
     it ships with the rest of the backend.

5. **Generate an admin token** (keep it secret — this protects your admin
   dashboard and the sync endpoint):
   ```
   openssl rand -hex 32
   ```

6. **Deploy**, from inside `backend/`:
   ```
   gcloud run deploy welverdiend-booking \
     --source . \
     --region europe-west1 \
     --allow-unauthenticated \
     --set-env-vars ADMIN_TOKEN=YOUR_GENERATED_TOKEN,PROOF_OF_PAYMENT_BUCKET=welverdiend-proof-of-payment
   ```
   Cloud Run will build the Docker image and give you a service URL like
   `https://welverdiend-booking-xxxxx-ew.a.run.app`. Copy it — you'll need it below.

7. **Grant the Cloud Run service account access** to Firestore and the
   bucket (usually automatic for the default compute service account, but
   if you get permission errors, add the "Cloud Datastore User" and
   "Storage Object Admin" roles to it in IAM).

8. **Set up the 10-minute sync schedule** with Cloud Scheduler:
   ```
   gcloud scheduler jobs create http welverdiend-sync \
     --schedule="*/10 * * * *" \
     --uri="https://YOUR-CLOUD-RUN-URL/api/sync" \
     --http-method=GET \
     --headers="x-admin-token=YOUR_GENERATED_TOKEN" \
     --location=europe-west1
   ```
   This is what keeps the calendar fresh every 10 minutes — Cloud Run
   itself can scale to zero between requests, so Scheduler is what wakes it up.

9. **Run one sync manually** to check it works:
   ```
   curl -H "x-admin-token: YOUR_GENERATED_TOKEN" https://YOUR-CLOUD-RUN-URL/api/sync
   ```
   You should get back `{"ok":true,"synced":[...]}`.

## Part 2 — Embed the calendar on your Squarespace site

1. Open `frontend/booking-widget.html` and set `API_BASE` near the top of
   the `<script>` to your Cloud Run URL from step 6 above. Also update the
   `EFT_DETAILS` line with your real bank details. Your logo is already
   embedded directly in the file (as base64) using the wordmark you sent —
   nothing to host separately. The color palette (taupe/greige) was sampled
   directly from your logo file, and the type pairing (Cormorant Garamond +
   Inter) echoes the tracked serif caps in your branding.

2. Host this HTML file somewhere public and stable. The two easiest options:
   - **Firebase Hosting** (free, on the same GCP project) — `firebase init hosting`, drop the file in as `index.html`, `firebase deploy`.
   - Or serve it directly from the Cloud Run backend as a static file (ask if you'd like this wired up).

3. In Squarespace: edit the page → add a **Code Block** → embed:
   ```html
   <iframe src="https://YOUR-HOSTED-WIDGET-URL"
           style="width:100%; border:none; min-height:900px;"
           title="Welverdiend Accommodation booking calendar"></iframe>
   ```
   Squarespace's Code Block supports raw HTML including iframes. Adjust
   `min-height` if the calendar looks cut off on mobile.

## Part 3 — Your admin dashboard

`frontend/admin-dashboard.html` is for you only — host it the same way
(Firebase Hosting works well), don't link to it from the public site.
Open it, paste in your admin token, and you'll see all booking requests
with buttons to view the proof-of-payment file and confirm or reject.

Confirming a booking marks it as blocking on your own calendar
immediately, and it'll appear in the `/ical/unit1.ics` / `/ical/unit2.ics`
export feeds within the next sync cycle — paste those URLs into Airbnb,
Booking.com and Lekkeslaap's "import calendar" settings once, and they'll
stay in sync automatically from then on.

## Costs

Cloud Run, Firestore, Cloud Storage and Cloud Scheduler all have generous
free tiers — for two units getting checked/synced every 10 minutes plus
occasional direct bookings, you should comfortably stay within GCP's free
tier or pay only a few dollars a month at most.

## What's intentionally left for you to plug in

- The three iCal export URLs per unit (`backend/config/units.js`)
- Your real bank/EFT details (`frontend/booking-widget.html`)
- Your Cloud Run service URL, once deployed (both frontend files)
- Where you host the two frontend HTML files (Firebase Hosting recommended)

If you'd like, I can also help wire up automatic guest confirmation
emails, or a simple booking-fee/deposit calculation — just say the word
once the base version is live.
