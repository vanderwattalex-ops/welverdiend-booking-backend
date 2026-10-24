/**
 * The guest Terms & Conditions and House Rules, as a PDF in the website's
 * look (Cormorant Garamond headings, Inter text, espresso and ochre on
 * white, a sand "house rules at a glance" page). Emailed with the invoice
 * once the deposit is confirmed (lib/email.js notifyGuestConfirmed).
 *
 * The wording mirrors site/policies.html; change both together.
 * Version date: TERMS_VERSION below.
 */
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

const TERMS_VERSION = "October 2026";

const ASSETS = path.join(__dirname, "..", "assets");
const FONT = {
  display: path.join(ASSETS, "fonts", "CormorantGaramond-SemiBold.ttf"),
  body: path.join(ASSETS, "fonts", "Inter-Regular.ttf"),
  bold: path.join(ASSETS, "fonts", "Inter-SemiBold.ttf")
};
const LOGO = path.join(__dirname, "..", "public", "letterhead-logo.png");
const SEAL = path.join(ASSETS, "pet-seal-600.png");

// The website's Safari lodge palette
const C = { espresso: "#3B2A1E", ochre: "#C68B3F", ochreInk: "#8E5F22", ink: "#24190F", soft: "#54412F", sand: "#F1E7D6", line: "#DCCBB0" };

const SECTIONS = [
  ["Welcome", [
    "Welcome to Welverdiend Accommodation. We want you to have a comfortable, peaceful and safe stay.",
    "These terms and house rules apply to every guest staying in Unit 1 or Unit 2. By paying the deposit and staying at the property, you agree to them on behalf of everyone in your group.",
    "If you booked through Airbnb, Booking.com or LekkeSlaap, that site's cancellation and payment policy applies to your booking. The house rules below apply to all guests."
  ]],
  ["Bookings and guests", [
    "Each unit sleeps up to 4 guests. Babies under 2 don't count towards the 4.",
    "The number of guests must match your booking. Please let us know before arrival if anything changes.",
    "Only the guests on the booking may stay overnight. Day visitors aren't allowed unless we've agreed to it in advance.",
    "No parties, events or gatherings."
  ]],
  ["Payment", [
    "Once we confirm your dates, a 50% deposit by EFT within 24 hours secures your booking. If we don't receive proof of payment in time, the dates are released.",
    "The balance is due before check-in. We send you a reminder 2 days before.",
    "We're not VAT-registered, so there's no VAT on our prices.",
    "Direct bookings may get a long-stay discount or a running special. A stay gets one discount: whichever saves you more. Discounts never apply to extras such as cleaning, laundry or firewood."
  ]],
  ["Cancellations and date changes", [
    "Cancel 5 days or more before check-in: you get a full refund.",
    "Cancel less than 5 days before check-in, or don't arrive: the deposit isn't refundable. Anything you paid above the deposit is refunded.",
    "If you can't come because of a death or hospitalisation of the person who booked or the person the booking is for, no cancellation penalty applies.",
    "Prefer different dates? We move your booking free of charge if the new dates are open.",
    "If we ever have to cancel, you get a full refund and we'll do our best to help you find somewhere else."
  ]],
  ["Arrival and departure", [
    "Check-in is from 14:00 with self check-in by lockbox, so you can arrive whenever suits you. There's no charge for arriving late.",
    "We send check-in instructions, the gate details and a pin drop before your stay. Please keep keys and gate details to yourself.",
    "Close the gate behind you every time you come and go, and don't let anyone else onto the property.",
    "Check-out is by 10:00. Leave the keys in the lockbox. Early check-in or late check-out is possible on request, subject to availability.",
    "Report lost or damaged keys or gate remotes to us straight away."
  ]],
  ["House rules", [
    "Quiet hours are 22:00 to 06:00. We're in a quiet neighbourhood and a peaceful setting; please keep noise down at all times so other guests and neighbours aren't disturbed.",
    "Smoking, vaping and e-cigarettes are allowed outside only. Please dispose of cigarette ends safely.",
    "Treat the furniture, appliances, linen and kitchen equipment with care, and leave the unit reasonably tidy.",
    "The accommodation may not be used for anything unlawful."
  ]],
  ["Pets", [
    "Any well-behaved pet is welcome at no extra charge. Please tell us what you're bringing when you book.",
    "Each unit has a private, fully fenced garden, and pet bowls are supplied.",
    "Springbok, ducks and chickens roam the property. Keep dogs on a lead or under close supervision outside the garden, never let them chase or frighten the animals, and keep them away from the ostrich camp.",
    "No pets in the pool area.",
    "Please look after your pet during your stay and clean up after them. Owners are responsible for any damage, extra cleaning or loss caused by their pets."
  ]],
  ["Pool and swimming dam", [
    "The farm-style pool is open all year and is shared. The pool area has a lockable gate; please close it behind you.",
    "There are stairs up to the deck and a ladder into the pool, so please make sure you can manage them.",
    "Children must be supervised by an adult at all times around the pool and the swimming dam.",
    "Swimming is at your own risk. There's no lifeguard."
  ]],
  ["Wildlife and outdoor areas", [
    "Walks around the property to see the wildlife are welcome, at your own risk.",
    "Keep a respectful distance from the animals. Don't feed, chase or corner them, and please don't feed the resident cat.",
    "Ostriches are dangerous. They live in their own closed camp: never go into it, keep children and pets away from it, and make sure its gates stay closed.",
    "Supervise children outdoors and around the animals at all times."
  ]],
  ["Braai, fireplace and power", [
    "Use the braai and fireplace only as intended. Never leave a fire unattended, and make sure it's fully out after use. Don't light fires in unsafe conditions.",
    "The fireplace surrounds get hot; keep children away while it's in use. Firewood is available at R100 per 50 kg bag.",
    "We run on solar and battery backup. During a long power cut the geyser may be switched off; the gas stove still works for cooking.",
    "Please don't tamper with the electrical, solar, battery, gas or security equipment, and report any faults to us."
  ]],
  ["Damage and breakages", [
    "We don't take a separate damage deposit, but you remain responsible for damage or loss caused by you or your group.",
    "Please report any breakage, damage, missing item or maintenance problem to us as soon as possible.",
    "We may ask you to pay the reasonable, evidenced cost of repairing or replacing what was damaged. For platform bookings, that platform's process applies.",
    "Please don't attempt repairs or move large items yourself, unless it's needed to deal with an immediate safety risk."
  ]],
  ["Parking and security", [
    "Each unit has 2 covered parking bays inside the fenced property, with room for a caravan, boat or trailer. The parking area isn't individually lockable.",
    "Please lock your vehicle and the unit when you go out, and look after your own belongings.",
    "Security cameras watch the entrance and the outside areas of the property. There are no cameras inside the units, and the footage is used for security only."
  ]],
  ["Cleaning and check-out", [
    "Please leave the unit reasonably tidy, put rubbish in the bins provided, and leave the kitchen in a reasonable state.",
    "A mid-stay clean (R250) and a laundry service (R150) are available on request.",
    "Make sure you've taken all your belongings, and leave the keys in the lockbox."
  ]],
  ["Safety and liability", [
    "Please take reasonable care of your own safety and that of everyone in your group, especially children and pets.",
    "Report hazards, injuries, security concerns or urgent problems to us as soon as possible. In an emergency, call the emergency services first.",
    "We aren't responsible for loss of or damage to guests' belongings, except where South African law makes us liable.",
    "Nothing in these terms limits any right you have that can't be limited under South African law, including the Consumer Protection Act."
  ]],
  ["Acceptance", [
    "By paying the deposit and staying at Welverdiend Accommodation, you confirm that you've read these terms and house rules and that your group will follow them.",
    "Questions? WhatsApp or call us on 079 118 3173, or email bookings@welverdiendaccommodation.com. We usually reply within an hour."
  ]]
];

// Short version for the "house rules at a glance" page
const AT_A_GLANCE = [
  ["Check-in", "From 14:00, self check-in by lockbox"],
  ["Check-out", "By 10:00, keys back in the lockbox"],
  ["Quiet hours", "22:00 to 06:00"],
  ["Guests", "Up to 4 per unit; no parties, events or day visitors"],
  ["Smoking", "Outside only, cigarette ends disposed of safely"],
  ["Gate", "Close it behind you, every time"],
  ["Pets", "Welcome; not in the pool area; clean up after them"],
  ["Wildlife", "Look, don't feed or chase the animals"],
  ["Ostriches", "Dangerous: stay out of their camp and keep its gates closed"],
  ["Pool and dam", "Children supervised at all times; swim at your own risk"],
  ["Fire", "Never leave the braai or fireplace unattended"],
  ["Power", "Solar backup; the geyser may be off in a long power cut"],
  ["Damage", "Tell us straight away about anything broken"],
  ["Cancellation", "Full refund 5+ days before check-in; after that the deposit isn't refundable"]
];

function fmtDate(d) { return new Date(d).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }); }

/**
 * Returns the PDF as a Buffer. `booking` (optional) personalises the cover
 * line ("Prepared for … · Unit 2 · 3 to 8 November 2026").
 */
function generateTerms(booking, unitName) {
  return new Promise((resolve, reject) => {
    const M = 56;
    const doc = new PDFDocument({ size: "A4", margins: { top: M, bottom: 70, left: M, right: M }, bufferPages: true,
      info: { Title: "Welverdiend Accommodation: Terms & Conditions and House Rules", Author: "Welverdiend Accommodation" } });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fontsOk = Object.values(FONT).every(f => fs.existsSync(f));
    if (fontsOk) {
      doc.registerFont("display", FONT.display);
      doc.registerFont("body", FONT.body);
      doc.registerFont("bold", FONT.bold);
    }
    const F = fontsOk ? { display: "display", body: "body", bold: "bold" } : { display: "Times-Bold", body: "Helvetica", bold: "Helvetica-Bold" };
    const W = doc.page.width - 2 * M;

    // ---- cover block
    if (fs.existsSync(LOGO)) doc.image(LOGO, M, M, { width: 190 });
    let y = M + 190 * (455 / 2042) + 20;
    doc.rect(M, y, W, 1.2).fill(C.ochre);
    y += 18;
    doc.font(F.bold).fontSize(8).fillColor(C.ochreInk).text("GUEST INFORMATION", M, y, { characterSpacing: 1.6 });
    doc.font(F.display).fontSize(28).fillColor(C.espresso).text("Terms & Conditions and House Rules", M, doc.y + 4, { width: W });
    doc.font(F.body).fontSize(9.5).fillColor(C.soft)
      .text("Welverdiend Accommodation · 4 Kenilworth Road, Groenvlei, Bloemfontein, 9301", M, doc.y + 4, { width: W });
    if (booking) {
      const who = [booking.guestName, unitName, booking.checkIn && booking.checkOut ? `${fmtDate(booking.checkIn)} to ${fmtDate(booking.checkOut)}` : null].filter(Boolean).join("  ·  ");
      const by = doc.y + 12;
      doc.rect(M, by, W, 26).fill(C.sand);
      doc.font(F.bold).fontSize(9).fillColor(C.espresso).text(`Prepared for: ${who}`, M + 12, by + 8.5, { width: W - 24 });
      doc.y = by + 26;
    }
    doc.moveDown(1.6);

    // ---- numbered sections
    SECTIONS.forEach(([title, items], i) => {
      // keep a heading with at least its first lines
      if (doc.y > doc.page.height - 150) doc.addPage();
      const hy = doc.y;
      doc.font(F.display).fontSize(15).fillColor(C.ochre).text(String(i + 1).padStart(2, "0"), M, hy, { width: 28, lineBreak: false });
      doc.font(F.display).fontSize(15).fillColor(C.espresso).text(title, M + 30, hy, { width: W - 30 });
      doc.moveDown(0.35);
      items.forEach(t => {
        const iy = doc.y;
        doc.save().rotate(45, { origin: [M + 34.7, iy + 5.9] }).rect(M + 33, iy + 4.2, 3.4, 3.4).fill(C.ochre).restore();
        doc.font(F.body).fontSize(9.6).fillColor(C.ink).text(t, M + 44, iy, { width: W - 44, lineGap: 2.2 });
        doc.moveDown(0.32);
      });
      doc.moveDown(0.7);
    });

    // ---- house rules at a glance (own page, sand panel sized to its content)
    doc.addPage();
    const sealW = 92, labelW = 112, padX = 24;
    const valW = W - 2 * padX - labelW;
    const rowH = ([k, v]) => {
      const h = Math.max(doc.font(F.bold).fontSize(10).heightOfString(k, { width: labelW }),
        doc.font(F.body).fontSize(10).heightOfString(v, { width: valW, lineGap: 1.5 }));
      return Math.max(h, 14) + 14;
    };
    const closing = "Questions or problems during your stay: WhatsApp or call 079 118 3173. In an emergency, call the emergency services first.";
    const rowsStart = 20 + sealW + 10;
    const panelH = rowsStart + AT_A_GLANCE.reduce((t, r) => t + rowH(r), 0) + 14 + 22 +
      doc.font(F.body).fontSize(9.5).heightOfString(closing, { width: W - 2 * padX }) + 26;
    const py = M;
    doc.rect(M, py, W, panelH).fill(C.sand);
    doc.rect(M, py, W, 4).fill(C.ochre);
    if (fs.existsSync(SEAL)) doc.image(SEAL, M + W - sealW - 18, py + 20, { width: sealW });
    doc.font(F.bold).fontSize(8).fillColor(C.ochreInk).text("PLEASE KEEP HANDY DURING YOUR STAY", M + padX, py + 28, { characterSpacing: 1.6 });
    doc.font(F.display).fontSize(26).fillColor(C.espresso).text("House rules at a glance", M + padX, doc.y + 4, { width: W - sealW - 60 });
    let ry = py + rowsStart;
    AT_A_GLANCE.forEach(row => {
      const [k, v] = row, h = rowH(row);
      doc.font(F.bold).fontSize(10).fillColor(C.espresso).text(k, M + padX, ry, { width: labelW });
      doc.font(F.body).fontSize(10).fillColor(C.ink).text(v, M + padX + labelW, ry, { width: valW, lineGap: 1.5 });
      doc.rect(M + padX, ry + h - 8, W - 2 * padX, 0.6).fill(C.line);
      ry += h;
    });
    doc.font(F.display).fontSize(15).fillColor(C.espresso).text("Thank you for staying with us.", M + padX, ry + 14, { width: W - 2 * padX });
    doc.font(F.body).fontSize(9.5).fillColor(C.soft).text(closing, M + padX, doc.y + 4, { width: W - 2 * padX });

    // ---- footer on every page
    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      doc.page.margins.bottom = 0; // the footer sits below the text area; don't let it start a new page
      const fy = doc.page.height - 44;
      doc.rect(M, fy - 10, W, 0.6).fill(C.line);
      doc.font(F.body).fontSize(7.5).fillColor(C.soft)
        .text(`Welverdiend Accommodation · welverdiendaccommodation.com · 079 118 3173 · Version ${TERMS_VERSION}`, M, fy, { width: W - 60, lineBreak: false });
      doc.text(`Page ${p + 1} of ${range.count}`, M + W - 60, fy, { width: 60, align: "right", lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { generateTerms, TERMS_VERSION };
