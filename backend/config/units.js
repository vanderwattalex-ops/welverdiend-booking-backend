// ---------------------------------------------------------------------------
// UNIT CONFIG — Welverdiend Accommodation
// ---------------------------------------------------------------------------
// Paste the iCal export (.ics) URLs for each unit, from each platform's host
// dashboard, into the arrays below. You can leave a platform blank ("") if a
// unit isn't listed there yet — it will just be skipped during sync.
//
// Where to find each export link:
//   Airbnb:      Host dashboard > Listing > Availability > "Sync calendars"
//                > "Export calendar" (copy the .ics link)
//   Booking.com: Extranet > Rates & Availability > Sync calendars > Export
//   Lekkeslaap:  Owner dashboard > Calendar > Export / iCal link
// ---------------------------------------------------------------------------

module.exports = {
  units: [
    {
      id: "unit2",
      name: "Unit 2",
      pricePerNight: 950,
      description: "Wildlife, tranquillity, and city convenience — your perfect escape. Two cozy bedrooms (one double, one with two singles), a spacious bathroom, a serene reading nook, and a dedicated work area. The open living space features a dining table, a welcoming lounge with a smart TV, and a fully equipped kitchen. Step outside to a tranquil setting where wildlife roams freely. Pet-friendly and peaceful — the perfect blend of comfort and wilderness, just minutes from the city.",
      beds: 3,
      bathrooms: 1,
      amenities: ["WiFi", "Pet-friendly", "Braai facilities", "Wildlife on the property"],
      photo: "/assets/unit2-exterior.jpg",
      sources: {
        airbnb: "https://www.airbnb.co.za/calendar/ical/1337503040346302823.ics?t=50fab091ad904775847a5324962b96b3",
        booking: "https://ical.booking.com/v1/export?t=eb733c15-159a-47b2-9c18-de39b684ccca",
        lekkeslaap: "https://www.lekkeslaap.co.za/suppliers/icalendar.ics?t=U1JHUEhQUkl0L2tQTWU4TUZJSEEzdz09"
      }
    },
    {
      id: "unit1",
      name: "Unit 1",
      // Rand per night — edit to your real rate. Shown to guests and used
      // server-side to calculate the total due.
      pricePerNight: 950,
      // Shown in the "Learn more about this unit" panel. Replace the
      // placeholders below with your real write-up, bed/bath counts,
      // amenities and a photo once you send them through.
      description: "A guest favourite, expanded. Following the success of our first Welverdiend house, we're excited to introduce this brand-new addition — the same peaceful retreat our guests love: private, tranquil, and surrounded by nature, yet just minutes from Bloemfontein's shops and attractions. Two cozy bedrooms — one with a double bed, the other with two single beds — perfect for families or friends. A spacious bathroom, a serene reading nook, and a dedicated work area for comfort and convenience. The open living space features a dining table, a welcoming lounge with a smart TV, and a fully equipped kitchen for effortless meals. Step outside to a tranquil setting where wildlife roams freely.",
      beds: 3,
      bathrooms: 1,
      amenities: ["WiFi", "Pet-friendly", "Braai facilities", "Wildlife on the property"],
      photo: "",
      sources: {
        airbnb: "https://www.airbnb.co.za/calendar/ical/1543967224420154478.ics?t=7cac96d84cd84b29ac746cabaf8a60e9",
        booking: "https://ical.booking.com/v1/export?t=46c3df03-7668-413d-8e94-c9591a840c1d",
        lekkeslaap: "https://www.lekkeslaap.co.za/suppliers/icalendar.ics?t=aVQxMmFidC9Bc3dZaE1WZ3oyalFhZz09"
      }
    }
  ],

  // Optional extras guests can add when booking. Every extra adds to the
  // total the guest must EFT. Edit freely — add, remove, rename, reprice.
  //   type "flat"  -> a single checkbox, adds `price` once per booking
  //   type "qty"   -> a quantity stepper, adds `price` × quantity (up to `max`)
  extras: [
    { id: "cleaning", label: "Extra cleaning service", description: "A mid-stay clean of your unit.", price: 350, type: "flat" },
    { id: "laundry", label: "Laundry / washing service", description: "We wash, dry and fold your laundry during your stay.", price: 150, type: "flat" },
    { id: "firewood", label: "Firewood bundle (braai)", description: "Per bundle, enough for one evening braai.", price: 120, type: "qty", max: 5 },
    { id: "breakfast", label: "Farm breakfast hamper", description: "Per person, delivered to your unit.", price: 95, type: "qty", max: 10 }
  ],

  // How often Cloud Scheduler should hit /api/sync (informational — the
  // actual cadence is set on the Cloud Scheduler job, see README).
  syncIntervalMinutes: 5,

  // Simple bearer token used to protect /api/admin/* and /api/sync.
  // Set the real value via the ADMIN_TOKEN environment variable — never
  // commit a real token to this file.
  adminTokenEnvVar: "ADMIN_TOKEN",

  // Where booking-request emails get sent for you to review.
  ownerNotificationEmail: "bookings@welverdiendaccommodation.com",

  // Shown to guests by email once you approve their dates, so they know
  // how to pay before uploading proof of payment.
  bankDetails: "Account: Welverdiend Accommodation | Bank: [your bank] | Acc no: [your account] | Ref: your name + check-in date",

  // The web address where you've hosted frontend/upload-proof.html (e.g.
  // your Firebase Hosting URL). Required for the "upload proof of
  // payment" link in approval emails to work — leave blank while you're
  // still testing locally, but you must set this before going live.
  frontendBaseUrl: "https://welverdiend-booking-478269051372.europe-west1.run.app"
};
