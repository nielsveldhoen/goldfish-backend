# SEO — voorstel

Status: **fase 3 gebouwd** (2026-09-19) — de pagina's staan in [`../site/`](../site/),
met een eigen README voor het serveren en een checklist vóór publicatie. Fase 1 en 2
zijn nog serverwerk. Raakt verder `frontend/web/`, de nginx-config op de Hetzner-box
en (fase 4) een nieuwe backend-route.

## De conclusie vooraf

`goldfishstudy.app` is op dit moment **onvindbaar via zoekmachines, en dat komt
niet door de meta-tags**. Het komt doordat er geen pagina's zijn. Er is precies
één URL, die een 4,6 MB grote Flutter-app laadt, die alles wat niet ingelogd is
doorstuurt naar `/login`. Wat een crawler ophaalt:

- **Geen tekst in de DOM.** De release-build rendert met CanvasKit; de inhoud
  staat in een canvas. Googlebot voert JavaScript uit, maar krijgt daarna nog
  steeds geen woord tekst te zien. Ook met de HTML-renderer zou er niets
  semantisch staan (geen `<h1>`, geen `<p>`, geen links).
- **Een inlogscherm op élke URL.** `app_router.dart` redirect alles naar
  `/login` zonder sessie, en `onException` stuurt onbekende URL's naar het
  dashboard — elke verzonnen URL geeft dus HTTP 200 met dezelfde lege app
  (soft-404's, slecht signaal).
- **Placeholderteksten.** `web/index.html`: `<title>goldfish_v1</title>`,
  `<meta name="description" content="A new Flutter project.">`, geen `lang`,
  geen canonical, geen og:/twitter-tags. `manifest.json` idem
  (`"name": "goldfish_v1"`). Er is geen `robots.txt` en geen `sitemap.xml`.

Die placeholders opruimen is een uur werk en moet gebeuren — maar het levert op
zichzelf **niets** op: een goed getitelde pagina zonder inhoud rankt nergens op.
Het echte voorstel is daarom: **zet een kleine, statische, indexeerbare
contentlaag náást de app**, en publiceer op termijn de publieke decks als echte
HTML-pagina's. In die volgorde.

En één ding vooraf over de naam: op "goldfish" ranken kan niet (aquariumvis,
crackers, de geheugen-mythe). Merk-zoekverkeer gaat er niet komen; alles moet
komen van probleem- en onderwerpwoorden. Dat maakt fase 3 belangrijker dan
gebruikelijk.

---

## Fase 1 — Hygiëne (~2 uur, geen architectuurwijziging)

Nodig als fundament, en er zit één directe niet-SEO-winst in: deelt iemand nu
een link in WhatsApp of Slack, dan staat daar **"goldfish_v1 — A new Flutter
project"** onder. Dat is meteen weg.

**`frontend/web/index.html`**

- `<html lang="nl">`.
- `<title>` en `<meta name="description">` met echte tekst.
- `<link rel="canonical">`.
- OG/Twitter-tags + een `og:image` van 1200×630 (mag de goudvis met een
  regel tekst zijn; `theme-color` staat al goed via de manifest).

**`frontend/web/manifest.json`** — echte `name`, `short_name`, `description`.
Die zie je ook terug in de PWA-installatieprompt, dus dit is net zo goed
productpolish.

**`frontend/web/robots.txt` + `sitemap.xml`** — alles in `web/` gaat mee in
`build/web/` en dus in de rsync van `deploy-web.sh`; geen serverwerk nodig.

**Op de server (nginx):**

- Controleer dat `index.html` **niet** lang gecachet wordt (`Cache-Control:
  no-cache`), anders blijven oude tags hangen. De hashed assets mogen wel lang.
- Echte `404` voor paden die geen app-route zijn, in plaats van de SPA-fallback
  op alles. Nu geeft elke typefout 200 + app.

**Aanmelden:** Google Search Console en Bing Webmaster Tools, verificatie via
een TXT-record in Cloudflare (DNS staat toch al op grijze wolk). Zonder Search
Console meet je later niets.

---

## Fase 2 — De app verhuist naar `/app`, de apex wordt een echte site (~1 dag)

Dit is het scharnierpunt. De homepage is de belangrijkste URL die je hebt, en
die is nu de app. Zolang dat zo is, valt er niets te indexeren.

**Voorstel: optie A.** nginx serveert `/` uit een nieuwe map
`/var/www/goldfish-site` (handgeschreven statische HTML, geen framework, geen
buildstap), en de Flutter-build komt onder `/app/`:

```
flutter build web --release --base-href /app/
rsync build/web/ → /var/www/goldfish/app/
```

Aandachtspunten bij de verhuizing:

- 301-redirects in nginx voor de bestaande deep links: `/decks`, `/login`,
  `/library`, … → `/app/…`. Die redirects blijven permanent staan.
- Geïnstalleerde PWA's houden hun oude `start_url` (`.`); die loopt via de
  301 goed af zolang de redirects blijven.
- De verify- en reset-mails raken **niet** stuk: die links wijzen naar
  `/auth/…`-routes op de backend (`app.js` r117-118), niet naar de
  webfrontend. Wel even `APP_URL` in `src/.env` naslaan om dat te bevestigen.
- `deploy-web.sh` moet mee: `WEB_ROOT` + de md5-verificatie wijzen straks naar
  `/var/www/goldfish/app/main.dart.js`.

**Overwogen en afgeraden:**

- *Optie B — app op `/` laten, contentpagina's op vaste paden ernaast.* Minder
  werk, maar de homepage blijft onindexeerbaar. Halve oplossing.
- *Optie C — prerender/SSR voor bots (Rendertron, prerender.io).* Extra
  bewegende delen op de box, een cloaking-achtige constructie, en het lost
  niets op: CanvasKit-output blijft tekstloos, dus je prerendert leegte.

**De koppeling tussen de twee helften** is een gewone `<a href="/app/login/register">`
— crawlbaar, en het is die link die Google vertelt dat site en app bij elkaar horen.
Eén knop volstaat voor iedereen: de redirect in `app_router.dart:27-31` stuurt wie al
ingelogd is vanaf `/login` meteen door naar zijn decks. Op de landingspagina's past
`site/app-link.js` alleen het *label* aan voor terugkerende bezoekers (nooit een
automatische doorverwijzing — iemand moet de prijzen kunnen nalezen, en Googlebot ziet
die toestand toch nooit).

Wat wél in de app moet gebeuren bij deze verhuizing: `<meta name="robots"
content="noindex">` in `frontend/web/index.html`, zodat `/app` niet als lege pagina in
de index belandt. Niet via `Disallow` in robots.txt — dan leest Google die tag nooit.
En `LoginPage` (`app_router.dart:218`) is nu zelf een landing; die rol neemt de
statische site over, dus daar kan het wervende deel uit.

Bijvangst: Core Web Vitals. De app haalt met 4,6 MB `main.dart.js` nooit een
goede LCP. Zodra de app niet meer de geïndexeerde pagina is, is dat ook geen
SEO-probleem meer — statische HTML-pagina's zijn vanzelf snel.

---

## Fase 3 — Content die daadwerkelijk kan ranken (het echte werk)

**Niet één pagina per zoekterm — één pagina per intentie.** Google matcht op
betekenis: "woordjes leren app", "app om te overhoren" en "hoe leer ik het snelst
woordjes" zijn dezelfde vraag, en worden door één goede pagina bediend. Pagina's die
op één woord na hetzelfde zijn, heten doorway pages, staan in Google's spambeleid en
kosten je meer dan ze opleveren. De toets is simpel: *zou het antwoord verschillen?*
Zo nee, is het één pagina.

**Begin met drie, niet met acht.** Dat is wat er nu in `../site/` staat:

| Pagina | Intentie |
|---|---|
| `index.html` | merk + propositie, hub naar de rest |
| `spaced-repetition.html` | uitleg — evergreen, lange staart |
| `vs-anki.html` | vergelijking — hoge intentie, mensen die al zoeken naar een alternatief |

Zet Search Console erop, wacht acht weken, en laat de query's waarop je dán al
vertoningen krijgt bepalen wat pagina vier wordt. Dat is goedkoper dan vooraf gokken,
en je schrijft alleen wat aantoonbaar gezocht wordt.

Kandidaten voor later, op volgorde van wat ik zou verwachten:

| Pagina | Waar het op mikt |
|---|---|
| **Plannen voor een tentamen** | `exam_planning` is je échte onderscheid t.o.v. Anki en Quizlet — hier geen concurrentie van de grote twee |
| Goldfish vs Quizlet | zelfde vorm als de Anki-pagina |
| Woordjes leren / overhoren | alleen als Search Console laat zien dat dit niet al op de uitlegpagina landt |
| Prijzen / Pro | pas zinvol zodra er een betaalflow is |
| Privacy | vertrouwen; hoort er toch te staan |

De examenplanner is het sterkste kaartje dat je hebt: "flashcards" is een
verzadigde markt, "leerschema voor je tentamen" veel minder.

**Talen:** de app spreekt nl/en/es/fr/de, maar vertaal de landingspagina's
níet allemaal. Begin met nl, en en pas hreflang toe zodra er echt twee versies
staan. Vijf talen marketingtekst onderhoud je niet.

---

## Fase 4 — Publieke decks als indexeerbare pagina's (compounding, maar mét haken)

Dit is de enige bron van SEO die groeit zonder dat jij elke pagina schrijft —
en tegelijk de enige met echte risico's. Daarom pas ná fase 1-3.

**Nu:** `GET /decks/public` (`shares.js` r464) zit achter `authMiddleware`
én eist een zoekterm van ≥2 tekens; er is bewust geen catalogus. Publieke decks
zijn dus voor een crawler volstrekt onzichtbaar.

**Voorstel:** een HTML-route op de backend, `goldfishstudy.app/deck/<slug>-<id>`,
met titel, omschrijving, tags, eigenaar, aantal kaarten, een preview van de
eerste ~10 kaarten als echte tekst, JSON-LD, en een CTA "deze set leren in
Goldfish". `sitemap.xml` genereren uit de database.

**Drie beslissingen die eerst genomen moeten worden — dit is geen technische
klus maar een productkeuze:**

1. **"Publiek" betekent nu iets anders dan "geïndexeerd".** Wie vandaag een deck
   publiek zet, maakt het vindbaar *binnen de app, na gericht zoeken*. Indexeren
   maakt het leesbaar voor iedereen op internet, permanent, inclusief
   Google-cache — met terugwerkende kracht, terwijl `is_public` onomkeerbaar is.
   **Aanbeveling: een aparte kolom `is_indexable`, default false, expliciete
   opt-in** met eigen tekst in de bevestigingsdialoog. Dat houdt de belofte bij
   het bestaande vinkje intact en is ook AVG-technisch het enige verdedigbare.
2. **Kwaliteitsdrempel.** Dunne en dubbele pagina's schaden het hele domein.
   Alleen decks met minstens ~10 kaarten indexeren, de rest `noindex`.
3. **Misbruik.** Zodra dit publiek is, is het een publicatieplatform: een
   meldknop en een takedown-route zijn geen luxe.

---

## Fase 5 — Meten en onderhouden

- **Search Console** maandelijks: welke query's, welke pagina's, wat is de
  klikverhouding. Dat stuurt fase 3 bij.
- **Analytics alleen op de marketingpagina's**, niet in de app: Plausible of
  umami op dezelfde box, cookieloos. In de app hoort het niet en het kost je
  een cookiebanner.
- Landingspagina's zijn statisch; zet er een vaste dag per kwartaal op om ze
  door te lopen, anders verouderen de vergelijkingspagina's ongemerkt.

---

## Volgorde en inschatting

| # | Wat | Werk | Wat het oplevert |
|---|---|---|---|
| 1 | Hygiëne + Search Console | ~2 uur | Niets in ranking; wel meteen fatsoenlijke deelvoorbeelden en een meetpunt |
| 2 | App naar `/app`, apex vrij | ~1 dag | Randvoorwaarde voor al het volgende |
| 3 | 3 landingspagina's | **gedaan** — staan in `../site/` | Het eerste echte verkeer |
| 4 | Publieke decks indexeren | ~2 dagen + productbeslissing | Groeit vanzelf door, ná 6-12 maanden |
| 5 | Meten | doorlopend | |

Fase 1 en 2 kunnen deze week. Fase 3 is geen programmeerwerk maar schrijfwerk,
en dat is meteen de flessenhals.

## Verwachtingen

Dit is een nichemarkt met twee zeer grote spelers erin. Reken op **maanden, niet
weken**: eerste vertoningen na 4-8 weken, eerste noemenswaardige klikken uit de
lange staart (vergelijkings- en uitlegpagina's) na een maand of drie. De
deckpagina's uit fase 4 zijn een investering die pas na 6-12 maanden zichtbaar
wordt — maar die daarna wél doorgroeit zonder extra werk.
