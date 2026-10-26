// Canonical default subject/body for every guest-facing email, written
// with the same {{placeholder}} tokens a custom override uses — this is
// the single source of truth for both what actually sends when nothing
// is customized, AND what's shown pre-filled in the dashboard's Settings
// tab so there's never a mismatch between the two.
const DEFAULT_EMAIL_TEMPLATES = {
  received: {
    subject: `We've received your booking request — Welverdiend Accommodation`,
    body: `
      <p>Hi {{guestName}},</p>
      <p>Thank you! We've received your request for <b>{{unitName}}, {{checkIn}} → {{checkOut}}</b> ({{nights}} night{{nightsSuffix}}), total <b>{{totalAmount}}</b>.</p>
      <p>There's no need to send it again. We'll check the dates and email you as soon as they're approved, usually within a few hours, with the banking details to pay the {{depositAmount}} deposit that secures your stay.</p>
      <p>Please note: your dates aren't reserved yet. They stay open until we approve your request; once approved, we hold them for you for 24 hours while you pay the deposit. Questions? Just reply to this email or WhatsApp us on 079 118 3173.</p>
    `
  },
  approved: {
    subject: `Good news — your dates at Welverdiend Accommodation are available`,
    body: `
      <p>Hi {{guestName}},</p>
      <p>We've checked and your dates are available: <b>{{checkIn}} → {{checkOut}}</b> at {{unitName}}.</p>
      <p>A <b>50% deposit of {{depositAmount}}</b> secures your booking (the remaining {{balanceAmount}} balance is due before check-in). Your invoice is attached, showing the full amount outstanding.</p>
      <p>Please pay the deposit by EFT to:<br>{{bankDetails}}</p>
      {{paymentInstructions}}
      <p>Please note: we hold your dates for 24 hours. If we haven't received your proof of payment by <b>{{depositDeadline}}</b>, the dates are released automatically.</p>
      <p><b>Please note:</b> a proof of payment on its own doesn't confirm your booking. We send your final confirmation once the deposit reflects in our bank account. If your check-in is within 3 days, please pay by <b>instant EFT</b> (immediate payment), as a normal EFT can take 1–2 working days to reflect.</p>
      <p>By paying the deposit you agree to our house rules &amp; policies, including the cancellation policy (a full refund up to 5 days before check-in; no refund after that or if you don't arrive): <a href="https://welverdiendaccommodation.com/policies.html">welverdiendaccommodation.com/policies.html</a></p>
    `
  },
  manualBooking: {
    subject: `Your booking at Welverdiend Accommodation — invoice attached`,
    body: `
      <p>Hi {{guestName}},</p>
      <p>Thank you for booking with us. We've reserved <b>{{unitName}}</b> for you from <b>{{checkIn}} → {{checkOut}}</b> ({{nights}} night{{nightsSuffix}}).</p>
      <p>Your invoice is attached. A <b>deposit of {{depositAmount}}</b> secures the booking, with the remaining {{balanceAmount}} due before check-in.</p>
      <p>Please pay the deposit by EFT to:<br>{{bankDetails}}</p>
      {{paymentInstructions}}
      <p>Any questions, just reply to this email — we look forward to hosting you.</p>
    `
  },
  rentInvoice: {
    subject: `Invoice {{invoiceNumber}} — Welverdiend Accommodation`,
    body: `
      <p>Hi {{tenantName}},</p>
      <p>Please find attached invoice <b>{{invoiceNumber}}</b>, dated {{invoiceDate}}, for <b>{{total}}</b>.</p>
      <p>{{terms}}</p>
      <p>Banking details:<br>{{bankDetails}}{{referenceLine}}</p>
      <p>{{popLine}}</p>
      <p>Thank you.</p>
    `
  },
  confirmed: {
    subject: `Confirmed — your stay at Welverdiend Accommodation`,
    body: `
      <p>Hi {{guestName}},</p>
      <p>Your booking is confirmed: <b>{{unitName}}, {{checkIn}} → {{checkOut}}</b>.</p>
      <p>Your deposit has been received. The remaining balance of <b>{{balanceAmount}}</b> is due before check-in — we'll be in touch closer to your stay with a link to pay it.</p>
      <p>Your invoice is attached for your records, together with our terms &amp; conditions and house rules. Please have a quick read before you arrive; the last page is a one-page summary of the house rules.</p>
      <p>We look forward to hosting you. If you have any questions before your stay, just reply to this email.</p>
    `
  },
  declined: {
    subject: `Update on your Welverdiend Accommodation booking request`,
    body: `
      <p>Hi {{guestName}},</p>
      <p>Unfortunately we're not able to confirm {{unitName}} for {{checkIn}} → {{checkOut}}{{reasonSuffix}}</p>
      <p>Please feel free to try different dates — we'd love to host you another time.</p>
    `
  },
  expired: {
    subject: `Your Welverdiend Accommodation booking request has expired`,
    body: `
      <p>Hi {{guestName}},</p>
      <p>Your approved request for {{unitName}}, {{checkIn}} → {{checkOut}}, has expired — we didn't receive your deposit proof of payment within 24 hours of approval.</p>
      <p>These dates have now been released and may be booked by someone else. If you'd still like to stay with us, please feel free to submit a new request.</p>
    `
  },
  balanceDue: {
    subject: `Final payment due — your stay at Welverdiend Accommodation`,
    body: `
      <p>Hi {{guestName}},</p>
      <p>Your stay at {{unitName}} ({{checkIn}} → {{checkOut}}) is coming up — the remaining balance of <b>{{balanceAmount}}</b> is now due.</p>
      {{paymentInstructions}}
      <p>We look forward to hosting you.</p>
    `
  },
  checkinReminder: {
    subject: `Your stay is coming up — check-in in 2 days`,
    body: `
      <p>Hi {{guestName}},</p>
      <p>Just a reminder that your stay at <b>{{unitName}}</b> starts on <b>{{checkIn}}</b> (check-out {{checkOut}}).</p>
      <p>Amount paid so far: <b>{{paidSoFar}}</b> of {{totalAmount}} total.</p>
      {{balanceStatusNote}}
      <p>We look forward to hosting you!</p>
    `
  },
  paidInFull: {
    subject: `Paid in full — see you soon at Welverdiend Accommodation`,
    body: `
      <p>Hi {{guestName}},</p>
      <p>We've received your final payment — you're all paid up for <b>{{unitName}}, {{checkIn}} → {{checkOut}}</b>.</p>
      <p>Your receipt is attached for your records.</p>
      <p>We look forward to hosting you!</p>
    `
  }
};

module.exports = { DEFAULT_EMAIL_TEMPLATES };
