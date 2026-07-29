# Welverdiend Accommodation — Booking Platform

Unified booking calendar for Unit 1 and Unit 2, syncing with Airbnb,
Booking.com and Lekkeslaap via iCal every 5 minutes, plus a direct
booking flow: guest requests dates → you approve → guest pays and
uploads proof → you give final confirmation — embeddable on your
Squarespace site.

## The booking flow, step by step

1. **Guest submits a request** through `booking-widget.html` — dates,
   guest details, extras. No payment yet. You get an email.
2. **You approve or decline** in `admin-dashboard.html`. Approving
   re-checks live availability first, so if a sync gap let something
   slip through, you'll see a conflict warning instead of approving a
   double-booking.
3. **The guest gets an email** with your bank details and a link to
   `upload-proof.html`, where they pay by EFT and upload proof.
4. **You get a second email** once they've uploaded it, and give final
   confirmation in the dashboard.
5. **Only now do the dates actually block** on the calendar — and get
   exported back out so Airbnb/Booking.com/Lekkeslaap pick them up too.

## How it fits together

```
Airbnb .ics ─┐
Booking.com .ics ─┼──► Cloud Scheduler (every 5 min) ──► Cloud Run backend ──► Firestore
Lekkeslaap .ics ─┘                                              │
                                                                  ▼
                                    Squarespace site (booking-widget.html) — guest requests dates
                                                                  │
                                    email to you ──► admin-dashboard.html — you Approve
                                                                  │
                                    email to guest ──► upload-proof.html — guest pays + uploads
                                                                  │
                                    email to you ──► admin-dashboard.html — you Confirm
                                                                  │
                                    dates now block, exported to /ical/unit1.ics
                                    and /ical/unit2.ics for Airbnb/Booking.com/Lekkeslaap
```

## Part 1 — Deploy the backend to Cloud Run

1. **Install the gcloud CLI** if you don't have it, then:
   ```
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

2. **Create a Cloud Storage bucket** for proof-of-payment uploads:
   ```
   gcloud storage buckets create gs://welverdiend-proof-of-payment --location=europe-west1
   ```
   (Keep it private — the admin dashboard reads files via short-lived signed URLs.)

3. **Enable Firestore** (Native mode) in the Cloud Console for your project, if not already on.

4. **Fill in `backend/config/units.js`:**
   - iCal source links for each unit/platform
   - `pricePerNight` per unit
   - `extras` — cleaning, laundry, firewood, breakfast, etc.
   - `ownerNotificationEmail` — where booking-request emails go (defaults to bookings@welverdiendaccommodation.com)
   - `bankDetails` — shown to guests once you approve their request
   - `frontendBaseUrl` — the web address where you'll host `upload-proof.html` (see Part 2). Leave blank while testing locally; **must be set before going live**, or the guest's approval email won't have a working upload link.

5. **Set up email sending** (so you get notified of requests, and guests get the approval/confirmation emails):
   - Use a Gmail address (personal or Google Workspace on your own domain).
   - Turn on **2-Step Verification** on that account if it isn't already: https://myaccount.google.com/security
   - Go to https://myaccount.google.com/apppasswords, create a new App Password (name it "Welverdiend Booking"), and copy the 16-character code it gives you.
   - You'll set this as `EMAIL_APP_PASSWORD` in the deploy step below, alongside `EMAIL_USER` (the Gmail address itself).

6. **Generate an admin token** (keep it secret):
   ```
   openssl rand -hex 32
   ```

7. **Deploy**, from inside `backend/`:
   ```
   gcloud run deploy welverdiend-booking \
     --source . \
     --region europe-west1 \
     --allow-unauthenticated \
     --set-env-vars ADMIN_TOKEN=YOUR_GENERATED_TOKEN,PROOF_OF_PAYMENT_BUCKET=welverdiend-proof-of-payment,EMAIL_USER=your-email@gmail.com,EMAIL_APP_PASSWORD=your16charapppassword
   ```
   Cloud Run gives you a service URL like `https://welverdiend-booking-xxxxx-ew.a.run.app` — copy it, you'll need it in Part 2.

8. **Grant the Cloud Run service account access** to Firestore and the
   bucket (usually automatic; if you get permission errors, add "Cloud
   Datastore User" and "Storage Object Admin" roles in IAM).

9. **Set up the 5-minute sync schedule** with Cloud Scheduler:
   ```
   gcloud scheduler jobs create http welverdiend-sync \
     --schedule="*/5 * * * *" \
     --uri="https://YOUR-CLOUD-RUN-URL/api/sync" \
     --http-method=GET \
     --headers="x-admin-token=YOUR_GENERATED_TOKEN" \
     --location=europe-west1
   ```
   (If you already created this job at the old 10-minute schedule, update
   it instead: `gcloud scheduler jobs update http welverdiend-sync --schedule="*/5 * * * *" --location=europe-west1`.)

10. **Run one sync manually** to check it works:
    ```
    curl -H "x-admin-token: YOUR_GENERATED_TOKEN" https://YOUR-CLOUD-RUN-URL/api/sync
    ```
    You should get back `{"ok":true,"synced":[...]}`.

## Part 2 — Your three pages, live at your Cloud Run URL

There are three guest/admin-facing pages in `frontend/`, and they now
deploy **together with the backend** — no separate hosting step needed.
Before each deploy, copy the current versions into `backend/site/` (this
is what actually ships):

```
copy the contents of frontend/booking-widget.html, frontend/admin-dashboard.html
and frontend/upload-proof.html into the matching files in backend/site/
```

Once deployed, all three are live at your Cloud Run URL:

- **`https://YOUR-CLOUD-RUN-URL/booking-widget.html`** — the public
  booking calendar. This is a real, shareable web page — post this exact
  link on Facebook, Instagram, WhatsApp, anywhere. No embedding required,
  though you can still embed it in Squarespace too (see below).
- **`https://YOUR-CLOUD-RUN-URL/upload-proof.html`** — where guests pay
  and upload proof, reached via the link in your approval email.
- **`https://YOUR-CLOUD-RUN-URL/admin-dashboard.html`** — for you only,
  don't share this one.

Set `API_BASE` at the top of each file's `<script>` to this same Cloud
Run URL before deploying — since all three now live on it too, `API_BASE`
and the page's own address are the same domain.

Also set `frontendBaseUrl` in `backend/config/units.js` to this same
Cloud Run URL, so approval emails link to the right place, then redeploy.

**Optional — embedding on Squarespace too:** edit the page → add a
**Code Block** → embed:
```html
<iframe src="https://YOUR-CLOUD-RUN-URL/booking-widget.html"
        style="width:100%; border:none; min-height:900px;"
        title="Welverdiend Accommodation booking calendar"></iframe>
```

*(If you'd rather keep the frontend on a separate address instead —
e.g. a nicer-looking URL via Firebase Hosting — that still works fine
too, just point `API_BASE` and `frontendBaseUrl` at your Cloud Run URL
as the backend either way.)*

## Part 3 — Using your admin dashboard day to day

Open `admin-dashboard.html`, paste in your admin token, and you'll see
every booking as a card with guest details, extras, and total. The
buttons shown change depending on where a booking is in the flow:

- **New request** → Approve (re-checks availability first) or Decline
- **Awaiting payment** → just a note that you're waiting on the guest;
  a Cancel option if needed
- **Ready to confirm** → View proof of payment, then Confirm or Reject
- **Confirmed / Rejected** → final states, proof still viewable

Declining or rejecting lets you type an optional short reason, which
gets included in the email sent to the guest.

## Seeing why a day is blocked, and unblocking one if needed

The **Calendar** tab in `admin-dashboard.html` lists every booked date
range per unit, showing exactly which platform(s) caused it (Airbnb,
Booking.com, Lekkeslaap, or a direct booking — with the guest's name for
direct bookings). Guests browsing `booking-widget.html` see a lighter
version of this too: hovering a booked day shows "Booked via Airbnb"
etc, without any guest name attached.

If a day is showing as booked but shouldn't be (a cancelled reservation
that hasn't cleared from a platform's feed yet, or a sync delay), use
**Unblock** next to that range, or the date-range form at the bottom of
each unit's card for a custom range. This only affects what your own
calendar shows and lets guests book — it does **not** cancel anything on
Airbnb, Booking.com or Lekkeslaap themselves, so only use it when you're
sure the dates are genuinely free. An unblock sticks around through
future syncs until you remove it with **Re-block**.

## Costs

Cloud Run, Firestore, Cloud Storage, Cloud Scheduler and Gmail sending
all have generous free tiers — for two units synced every 5 minutes
plus occasional bookings, you should stay within GCP's free tier or pay
only a few dollars a month at most.

## What's intentionally left for you to plug in

- `ownerNotificationEmail`, `bankDetails`, `frontendBaseUrl` in `backend/config/units.js` (set `frontendBaseUrl` to your Cloud Run URL)
- `EMAIL_USER` / `EMAIL_APP_PASSWORD` at deploy time
- `API_BASE` in all three frontend files, set to your Cloud Run URL, copied into `backend/site/` before each deploy
