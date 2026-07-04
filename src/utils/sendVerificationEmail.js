import { Resend } from "resend";

// Object-export zodat tests de verzendmethode kunnen vervangen met
// mock.method() — ESM named exports zijn zelf niet te mocken op Node 18.
export const mailer = {
  async sendVerificationEmail(email, token) {
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
  },
};

export const sendVerificationEmail = (email, token) =>
  mailer.sendVerificationEmail(email, token);
