import { Resend } from "resend";

export async function sendVerificationEmail(email, token) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const verifyUrl = `${process.env.APP_URL}/auth/verify-email?token=${token}`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: email,
    subject: "Bevestig je Goldfish-account",
    html: `
      <p>Welkom bij Goldfish!</p>
      <p>Klik op de onderstaande link om je e-mailadres te bevestigen:</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>Deze link is 24 uur geldig.</p>
    `,
  });
}
