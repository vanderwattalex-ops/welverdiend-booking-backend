const nodemailer = require("nodemailer");
const { getSettings } = require("./settings");

// Uses Gmail's SMTP with an "App Password" — set EMAIL_USER and
// EMAIL_APP_PASSWORD as environment variables (see README for how to
// generate an App Password). Works for a plain Gmail address or a Google
// Workspace address on your own domain.
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
  });
  return transporter;
}

async function sendMail({ to, subject, html, attachments }) {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] EMAIL_USER / EMAIL_APP_PASSWORD not set — skipping email:", subject, "to:", to);
    return { sent: false, reason: "Email is not configured (EMAIL_USER / EMAIL_APP_PASSWORD missing)." };
  }
  if (!to) {
    console.warn("[email] No recipient address for:", subject);
    return { sent: false, reason: "No recipient address was set." };
  }
  try {
    await t.sendMail({ from: `Welverdiend Accommodation <${process.env.EMAIL_USER}>`, to, subject, html, attachments });
    console.log("[email] sent:", subject, "to:", to);
    return { sent: true };
  } catch (err) {
    // A failed email should never break the booking flow itself.
    console.error("[email] failed to send:", subject, "to:", to, "-", err.message);
    return { sent: false, reason: err.message };
  }
}

function fmtDate(d) { return new Date(d).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }); }
function rand(n) { return `R${Number(n || 0).toFixed(2)}`; }

// Fills {{token}} placeholders in a custom template with plain string
// substitution — no conditionals or loops. Any token with no matching
// value (or a value of null/undefined) is replaced with "" rather than
// left as a literal {{token}} in the sent email.
function fillTemplate(str, vars) {
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ""));
}

/**
 * Every guest-facing email has a hardcoded default (subject + HTML) —
 * that's what actually gets sent unless you've customized that email
 * type in the dashboard's Settings tab. A custom template only needs to
 * override subject OR body; whichever one you leave blank keeps using
 * the default for that half.
 */
async function resolveEmail(templateKey, vars, fallbackSubject, fallbackHtml) {
  const { emailTemplates } = await getSettings();
  const override = emailTemplates && emailTemplates[templateKey];
  return {
    subject: override && override.subject ? fillTemplate(override.subject, vars) : fallbackSubject,
    html: override && override.body ? fillTemplate(override.body, vars) : fallbackHtml
  };
}

async function notifyOwnerNewRequest(booking, unitName) {
  const { ownerNotificationEmail } = await getSettings();
  return sendMail({
    to: ownerNotificationEmail,
    subject: `New booking request — ${unitName}, ${fmtDate(booking.checkIn)}`,
    html: `
      <p>A new booking request has come in and is waiting for your review.</p>
      <ul>
        <li><b>Unit:</b> ${unitName}</li>
        <li><b>Dates:</b> ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)} (${booking.nights} night${booking.nights === 1 ? "" : "s"})</li>
        <li><b>Guest:</b> ${booking.guestName} (${booking.email}, ${booking.phone})</li>
        <li><b>Guests:</b> ${booking.adults} adult${booking.adults === 1 ? "" : "s"}${booking.children ? `, ${booking.children} child${booking.children === 1 ? "" : "ren"}` : ""}</li>
        <li><b>Pets:</b> ${booking.hasPets ? (booking.petDetails || "Yes") : "No"}</li>
        <li><b>Total:</b> ${rand(booking.totalAmount)} (${rand(booking.depositAmount)} deposit + ${rand(booking.balanceAmount)} balance)</li>
      </ul>
      <p>Open your admin dashboard to approve or decline these dates.</p>
    `
  });
}

async function notifyGuestApproved(booking, unitName, invoiceBuffer) {
  const { bankDetails, frontendBaseUrl } = await getSettings();
  const uploadUrl = frontendBaseUrl ? `${frontendBaseUrl}/upload-proof.html?booking=${booking.id}` : "";
  const paymentInstructions = uploadUrl
    ? `<p>Once you've paid, upload your proof of payment here to secure your booking:<br><a href="${uploadUrl}">${uploadUrl}</a></p>`
    : `<p>Please reply to this email with your proof of payment to secure your booking.</p>`;

  const vars = {
    guestName: booking.guestName, unitName, checkIn: fmtDate(booking.checkIn), checkOut: fmtDate(booking.checkOut),
    nights: booking.nights, depositAmount: rand(booking.depositAmount), balanceAmount: rand(booking.balanceAmount),
    bankDetails, uploadUrl, paymentInstructions
  };
  const fallbackSubject = `Good news — your dates at Welverdiend Accommodation are available`;
  const fallbackHtml = `
    <p>Hi ${booking.guestName},</p>
    <p>We've checked and your dates are available: <b>${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}</b> at ${unitName}.</p>
    <p>A <b>50% deposit of ${rand(booking.depositAmount)}</b> secures your booking (the remaining ${rand(booking.balanceAmount)} balance is due before check-in). Your invoice is attached, showing the full amount outstanding.</p>
    <p>Please pay the deposit by EFT to:<br>${bankDetails}</p>
    ${paymentInstructions}
    <p>We'll send a final confirmation as soon as we've checked it.</p>
  `;
  const { subject, html } = await resolveEmail("approved", vars, fallbackSubject, fallbackHtml);
  return sendMail({
    to: booking.email, subject, html,
    attachments: invoiceBuffer ? [{ filename: `invoice-${booking.id.slice(0, 8)}.pdf`, content: invoiceBuffer }] : undefined
  });
}

async function notifyOwnerProofUploaded(booking, unitName) {
  const { ownerNotificationEmail } = await getSettings();
  return sendMail({
    to: ownerNotificationEmail,
    subject: `Deposit proof uploaded — ${unitName}, ${fmtDate(booking.checkIn)}`,
    html: `
      <p>${booking.guestName} has uploaded deposit proof of payment (${rand(booking.depositAmount)}) for ${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}.</p>
      <p>Open your admin dashboard to check it and give final confirmation.</p>
    `
  });
}

async function notifyGuestConfirmed(booking, unitName, invoiceBuffer) {
  const vars = {
    guestName: booking.guestName, unitName, checkIn: fmtDate(booking.checkIn), checkOut: fmtDate(booking.checkOut),
    nights: booking.nights, balanceAmount: rand(booking.balanceAmount)
  };
  const fallbackSubject = `Confirmed — your stay at Welverdiend Accommodation`;
  const fallbackHtml = `
    <p>Hi ${booking.guestName},</p>
    <p>Your booking is confirmed: <b>${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}</b>.</p>
    <p>Your deposit has been received. The remaining balance of <b>${rand(booking.balanceAmount)}</b> is due before check-in — we'll be in touch closer to your stay with a link to pay it.</p>
    <p>Your invoice is attached for your records.</p>
    <p>We look forward to hosting you. If you have any questions before your stay, just reply to this email.</p>
  `;
  const { subject, html } = await resolveEmail("confirmed", vars, fallbackSubject, fallbackHtml);
  return sendMail({
    to: booking.email, subject, html,
    attachments: invoiceBuffer ? [{ filename: `invoice-${booking.id.slice(0, 8)}.pdf`, content: invoiceBuffer }] : undefined
  });
}

async function notifyGuestDeclined(booking, unitName, reason) {
  const reasonSuffix = reason ? `: ${reason}` : ".";
  const vars = {
    guestName: booking.guestName, unitName, checkIn: fmtDate(booking.checkIn), checkOut: fmtDate(booking.checkOut),
    nights: booking.nights, reason: reason || "", reasonSuffix
  };
  const fallbackSubject = `Update on your Welverdiend Accommodation booking request`;
  const fallbackHtml = `
    <p>Hi ${booking.guestName},</p>
    <p>Unfortunately we're not able to confirm ${unitName} for ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}${reasonSuffix}</p>
    <p>Please feel free to try different dates — we'd love to host you another time.</p>
  `;
  const { subject, html } = await resolveEmail("declined", vars, fallbackSubject, fallbackHtml);
  return sendMail({ to: booking.email, subject, html });
}

async function notifyGuestExpired(booking, unitName) {
  const vars = {
    guestName: booking.guestName, unitName, checkIn: fmtDate(booking.checkIn), checkOut: fmtDate(booking.checkOut),
    nights: booking.nights
  };
  const fallbackSubject = `Your Welverdiend Accommodation booking request has expired`;
  const fallbackHtml = `
    <p>Hi ${booking.guestName},</p>
    <p>Your approved request for ${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}, has expired — we didn't receive your deposit proof of payment within 24 hours of approval.</p>
    <p>These dates have now been released and may be booked by someone else. If you'd still like to stay with us, please feel free to submit a new request.</p>
  `;
  const { subject, html } = await resolveEmail("expired", vars, fallbackSubject, fallbackHtml);
  return sendMail({ to: booking.email, subject, html });
}

async function notifyGuestBalanceDue(booking, unitName) {
  const { frontendBaseUrl } = await getSettings();
  const uploadUrl = frontendBaseUrl ? `${frontendBaseUrl}/upload-proof.html?booking=${booking.id}` : "";
  const paymentInstructions = uploadUrl
    ? `<p>Please pay by EFT and upload your proof of payment here:<br><a href="${uploadUrl}">${uploadUrl}</a></p>`
    : `<p>Please reply to this email once you've paid the balance.</p>`;

  const vars = {
    guestName: booking.guestName, unitName, checkIn: fmtDate(booking.checkIn), checkOut: fmtDate(booking.checkOut),
    nights: booking.nights, balanceAmount: rand(booking.balanceAmount), uploadUrl, paymentInstructions
  };
  const fallbackSubject = `Final payment due — your stay at Welverdiend Accommodation`;
  const fallbackHtml = `
    <p>Hi ${booking.guestName},</p>
    <p>Your stay at ${unitName} (${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}) is coming up — the remaining balance of <b>${rand(booking.balanceAmount)}</b> is now due.</p>
    ${paymentInstructions}
    <p>We look forward to hosting you.</p>
  `;
  const { subject, html } = await resolveEmail("balanceDue", vars, fallbackSubject, fallbackHtml);
  return sendMail({ to: booking.email, subject, html });
}

async function notifyGuestCheckinReminder(booking, unitName) {
  const { frontendBaseUrl } = await getSettings();
  const uploadUrl = frontendBaseUrl ? `${frontendBaseUrl}/upload-proof.html?booking=${booking.id}` : "";
  const paidSoFar = booking.balanceStatus === "paid" ? booking.totalAmount : booking.depositAmount;
  const balanceStatusNote = booking.balanceStatus === "paid"
    ? `<p>You're paid in full — nothing further owed.</p>`
    : `<p>Your remaining balance of <b>${rand(booking.balanceAmount)}</b> is still due. ${uploadUrl ? `Please pay by EFT and upload proof here: <a href="${uploadUrl}">${uploadUrl}</a>` : "Please arrange payment before check-in."}</p>`;

  const vars = {
    guestName: booking.guestName, unitName, checkIn: fmtDate(booking.checkIn), checkOut: fmtDate(booking.checkOut),
    paidSoFar: rand(paidSoFar), totalAmount: rand(booking.totalAmount), balanceAmount: rand(booking.balanceAmount),
    uploadUrl, balanceStatusNote
  };
  const fallbackSubject = `Your stay is coming up — check-in in 2 days`;
  const fallbackHtml = `
    <p>Hi ${booking.guestName},</p>
    <p>Just a reminder that your stay at <b>${unitName}</b> starts on <b>${fmtDate(booking.checkIn)}</b> (check-out ${fmtDate(booking.checkOut)}).</p>
    <p>Amount paid so far: <b>${rand(paidSoFar)}</b> of ${rand(booking.totalAmount)} total.</p>
    ${balanceStatusNote}
    <p>We look forward to hosting you!</p>
  `;
  const { subject, html } = await resolveEmail("checkinReminder", vars, fallbackSubject, fallbackHtml);
  return sendMail({ to: booking.email, subject, html });
}

async function notifyGuestPaidInFull(booking, unitName, invoiceBuffer) {
  const vars = {
    guestName: booking.guestName, unitName, checkIn: fmtDate(booking.checkIn), checkOut: fmtDate(booking.checkOut),
    nights: booking.nights
  };
  const fallbackSubject = `Paid in full — see you soon at Welverdiend Accommodation`;
  const fallbackHtml = `
    <p>Hi ${booking.guestName},</p>
    <p>We've received your final payment — you're all paid up for <b>${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}</b>.</p>
    <p>Your receipt is attached for your records.</p>
    <p>We look forward to hosting you!</p>
  `;
  const { subject, html } = await resolveEmail("paidInFull", vars, fallbackSubject, fallbackHtml);
  return sendMail({
    to: booking.email, subject, html,
    attachments: invoiceBuffer ? [{ filename: `receipt-${booking.id.slice(0, 8)}.pdf`, content: invoiceBuffer }] : undefined
  });
}

async function notifyOwnerBalanceProofUploaded(booking, unitName) {
  const { ownerNotificationEmail } = await getSettings();
  return sendMail({
    to: ownerNotificationEmail,
    subject: `Final payment proof uploaded — ${unitName}, ${fmtDate(booking.checkIn)}`,
    html: `
      <p>${booking.guestName} has uploaded proof of the final balance payment (${rand(booking.balanceAmount)}) for ${unitName}, ${fmtDate(booking.checkIn)} → ${fmtDate(booking.checkOut)}.</p>
      <p>Open your admin dashboard to check it and mark the balance as received.</p>
    `
  });
}

async function sendTestEmail(to) {
  return sendMail({
    to,
    subject: "Test email from your Welverdiend Accommodation booking system",
    html: `<p>This is a test email — if you're reading this, notification emails are working correctly.</p>`
  });
}

module.exports = {
  notifyOwnerNewRequest,
  notifyGuestApproved,
  notifyOwnerProofUploaded,
  notifyGuestConfirmed,
  notifyGuestDeclined,
  notifyGuestExpired,
  notifyGuestBalanceDue,
  notifyGuestCheckinReminder,
  notifyGuestPaidInFull,
  notifyOwnerBalanceProofUploaded,
  sendTestEmail
};
