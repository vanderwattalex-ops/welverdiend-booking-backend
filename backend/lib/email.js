const nodemailer = require("nodemailer");
const { getSettings } = require("./settings");
const { DEFAULT_EMAIL_TEMPLATES } = require("./emailTemplates");

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
 * Every guest-facing email has a built-in default (subject + HTML,
 * defined once in emailTemplates.js) — that's what actually gets sent
 * unless you've customized that email type in the dashboard's Settings
 * tab. A custom override only needs to replace subject OR body;
 * whichever one is left blank keeps using the default for that half.
 */
async function resolveEmail(templateKey, vars) {
  const { emailTemplates } = await getSettings();
  const override = emailTemplates && emailTemplates[templateKey];
  const defaults = DEFAULT_EMAIL_TEMPLATES[templateKey];
  const subjectTemplate = override && override.subject ? override.subject : defaults.subject;
  const bodyTemplate = override && override.body ? override.body : defaults.body;
  return { subject: fillTemplate(subjectTemplate, vars), html: fillTemplate(bodyTemplate, vars) };
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
  const { subject, html } = await resolveEmail("approved", vars);
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
  const { subject, html } = await resolveEmail("confirmed", vars);
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
  const { subject, html } = await resolveEmail("declined", vars);
  return sendMail({ to: booking.email, subject, html });
}

async function notifyGuestExpired(booking, unitName) {
  const vars = {
    guestName: booking.guestName, unitName, checkIn: fmtDate(booking.checkIn), checkOut: fmtDate(booking.checkOut),
    nights: booking.nights
  };
  const { subject, html } = await resolveEmail("expired", vars);
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
  const { subject, html } = await resolveEmail("balanceDue", vars);
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
  const { subject, html } = await resolveEmail("checkinReminder", vars);
  return sendMail({ to: booking.email, subject, html });
}

async function notifyGuestPaidInFull(booking, unitName, invoiceBuffer) {
  const vars = {
    guestName: booking.guestName, unitName, checkIn: fmtDate(booking.checkIn), checkOut: fmtDate(booking.checkOut),
    nights: booking.nights
  };
  const { subject, html } = await resolveEmail("paidInFull", vars);
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
