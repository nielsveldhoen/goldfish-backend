// Blocklist van veelgelekte wachtwoorden (SECURITY_PLAN.md, stap 2.5).
//
// Bewust een lokale lijst en geen externe API (haveibeenpwned): geen extra
// dependency, geen netwerk-call in het registratiepad, geen privacy-vraagstuk.
//
// De lijst bevat alléén wachtwoorden van >= 8 tekens: korter wordt al geweigerd
// door de minimumlengte, dus die entries zouden dode ballast zijn. Dit is de
// doorsnede van de bekende "meest gebruikte wachtwoorden"-lijsten (rockyou /
// SecLists top-1000) met die lengte-eis, aangevuld met de Nederlandse
// varianten die in die Engelstalige lijsten ontbreken.
//
// Vergelijking is case-insensitief: "Password123" is niet veiliger dan
// "password123".

const COMMON_PASSWORDS = new Set([
  // Cijferreeksen
  "12345678", "123456789", "1234567890", "12345678910", "123456789012",
  "01234567", "012345678", "87654321", "987654321", "0987654321",
  "11111111", "00000000", "22222222", "33333333", "55555555", "66666666",
  "77777777", "88888888", "99999999", "121212121", "123123123", "112233445",
  "10101010", "12341234", "12portugal", "147258369", "159753456", "1q2w3e4r",
  "1q2w3e4r5t", "1qaz2wsx", "1qazxsw2", "qazwsxedc", "zaq12wsx", "1qaz2wsx3edc",

  // Toetsenbordpatronen
  "qwertyui", "qwertyuiop", "qwerty123", "qwerty12", "qwerty123456",
  "asdfghjk", "asdfghjkl", "zxcvbnm1", "qweasdzxc", "qwertyuio",
  "poiuytrewq", "mnbvcxz1", "asdf1234", "qwer1234", "qwerasdf", "1234qwer",

  // "password" en varianten
  "password", "password1", "password12", "password123", "password1234",
  "password!", "password@", "password01", "password2", "password3",
  "passw0rd", "p@ssword", "p@ssw0rd", "pa55word", "passwort", "wachtwoord",
  "wachtwoord1", "wachtwoord123", "mypassword", "newpassword", "yourpassword",
  "passwordpassword", "letmein1", "letmein123", "iloveyou1", "trustno1",

  // Sport, merken, popcultuur
  "football", "football1", "baseball", "baseball1", "basketball", "superman",
  "batman123", "starwars", "pokemon1", "princess", "princess1", "sunshine",
  "computer", "internet", "samsung1", "michael1", "jennifer", "jordan23",
  "liverpool", "arsenal1", "chelsea1", "barcelona", "juventus", "manutd",
  "ajax1234", "feyenoord", "psv12345", "oranje123", "minecraft", "fortnite",
  "pokemon123", "spiderman", "harrypotter", "gandalf1", "slipknot",

  // Namen en woorden (>= 8 tekens)
  "michelle", "jessica1", "nicole12", "danielle", "samantha", "veronica",
  "charlie1", "chocolate", "butterfly", "sweetheart", "whatever", "welcome1",
  "welcome123", "welkom123", "welkom01", "welkom2024", "welkom2025",
  "monkey12", "monkey123", "dragon123", "shadow12", "master12", "master123",
  "hunter123", "ranger123", "soccer12", "cheese123", "orange12", "purple12",
  "midnight", "flower123", "freedom1", "forever1", "friends1",

  // Toegangs- en systeemklassiekers
  "admin123", "administrator", "adminadmin", "admin1234", "root1234",
  "changeme", "changeme1", "letmein12", "default1", "guest123", "test1234",
  "testtest", "temp1234", "secret12", "secret123", "abc12345", "abcd1234",
  "abcd12345", "aaaaaaaa", "iloveyou", "loveyou1", "asdfasdf", "zxcvzxcv",
  "qweqweqwe", "photoshop", "michael123", "google123", "facebook",
  "facebook1", "whatsapp", "instagram", "snapchat", "netflix1",

  // Datums en jaartallen
  "01011990", "01012000", "12345678a", "password2024", "password2025",
  "welcome2024", "welcome2025", "summer2024", "summer2025", "winter2024",
  "spring2024", "autumn2024", "january1", "december1", "2024password",

  // Nederlandse veelgebruikers
  "geheim123", "geheim12", "welkom1234", "voetbal1", "voetbal123",
  "vakantie1", "amsterdam", "amsterdam1", "rotterdam", "nederland",
  "nederland1", "eindhoven", "groningen", "hallo123", "hallohallo",
  "zonnetje1", "lekkerding", "kaaskop123", "konijn123", "poesje123",
  "moederke1", "vaderke12", "schooltje", "computer1", "computer123",
]);

// True als het wachtwoord op de blocklist staat. Case-insensitief; whitespace
// aan de randen telt niet mee (die typt niemand bewust).
export function isCommonPassword(password) {
  if (typeof password !== "string") return false;
  return COMMON_PASSWORDS.has(password.trim().toLowerCase());
}

export const COMMON_PASSWORD_ERROR =
  "This password is too common. Choose a less predictable password.";
