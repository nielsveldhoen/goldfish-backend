import { Resend } from "resend";

// Object-export zodat tests de verzendmethoden kunnen vervangen met
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

  // De reset-pagina is een browser-flow en leeft buiten het /v2-prefix
  // (geen X-Client-Build in een browser), zie src/routes/passwordReset.js.
  async sendPasswordResetEmail(email, token) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const resetUrl = `${process.env.APP_URL}/auth/reset-password?token=${token}`;

    await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: email,
      subject: "Stel je Goldfish-wachtwoord opnieuw in",
      html: `
        <p>Er is een wachtwoord-reset aangevraagd voor je Goldfish-account.</p>
        <p>Klik op de onderstaande link om een nieuw wachtwoord in te stellen:</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
        <p>Deze link is 1 uur geldig. Heb je dit niet aangevraagd, dan kun
        je deze mail negeren — je wachtwoord blijft ongewijzigd.</p>
      `,
    });
  },

  // Gestuurd wanneer iemand zich registreert met een e-mailadres dat al een
  // account heeft. De API-response is dan identiek aan een geslaagde
  // registratie (anti-enumeration); deze mail vertelt de échte eigenaar wat
  // er aan de hand is en wijst naar de reset-flow.
  async sendAccountExistsEmail(email) {
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: email,
      subject: "Je hebt al een Goldfish-account",
      html: `
        <p>Er is zojuist geprobeerd een Goldfish-account aan te maken met dit
        e-mailadres, maar je hebt al een account.</p>
        <p>Was jij dit en ben je je wachtwoord vergeten? Gebruik dan
        "Wachtwoord vergeten" in de app om een nieuw wachtwoord in te
        stellen.</p>
        <p>Was jij dit niet, dan hoef je niets te doen.</p>
      `,
    });
  },

  // Bevestiging van een verwijderaanvraag (DELETE /v2/auth/me). Binnen de
  // bedenktijd kan de eigenaar terug door in te loggen en de verwijdering te
  // annuleren — dat vereist het wachtwoord, dus een gestolen sessie kan er
  // niet mee weglopen.
  async sendAccountDeletionEmail(email, effectiveAt) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const datum = new Date(effectiveAt).toLocaleDateString("nl-NL", {
      day: "numeric", month: "long", year: "numeric",
    });

    await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: email,
      subject: "Je Goldfish-account wordt verwijderd",
      html: `
        <p>Er is zojuist gevraagd dit Goldfish-account te verwijderen. Je bent
        op alle apparaten uitgelogd en het account wordt definitief gewist op
        <strong>${datum}</strong>.</p>
        <p>Was jij dit niet, of heb je spijt? Log vóór die datum opnieuw in
        met je wachtwoord en kies "Verwijdering annuleren" — dan blijft alles
        behouden.</p>
        <p>Decks die je met anderen deelt en die zij actief gebruiken, blijven
        na de verwijdering anoniem voor hen beschikbaar.</p>
      `,
    });
  },
};

export const sendVerificationEmail = (email, token) =>
  mailer.sendVerificationEmail(email, token);
