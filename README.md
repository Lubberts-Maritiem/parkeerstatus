# Parkeren op de Haven

Indicatieve parkeerdrukte op het Veerhavenplein, West-Terschelling. Volledig gratis te draaien op **Vercel (Hobby)** plus het gratis dagtegoed van **Cloudflare Workers AI**.

## Hoe het werkt

1. `index.html` toont de livestream van de havencamera en een statuskaart: rustig, gemiddeld, druk of vol.
2. De pagina vraagt elke minuut `/api/status` op.
3. `/api/status` pakt met ffmpeg één frame uit de stream, zet het onder twee referentiefoto's (leeg en vol) en vraagt een vision-model op Cloudflare: *waar zit dit beeld tussen leeg (0) en vol (100)?*
4. Vercel's CDN bewaart het antwoord 4 minuten (`s-maxage`). Hoeveel bezoekers er ook zijn, de meting draait hooguit eens per 4 minuten. 's Nachts (23:00 tot 06:00) eens per 30 minuten.
5. Valt de livestream weg, dan toont de pagina het frame van de laatste meting. Mislukt een meting, dan blijft de laatste geslaagde meting staan met een melding.

Geen database, geen cron, geen eigen server.

## In gebruik nemen (ongeveer 20 minuten)

### 1. Cloudflare (gratis)

1. Maak een gratis account op [dash.cloudflare.com](https://dash.cloudflare.com).
2. Noteer je **Account ID**: staat op de overzichtspagina van je account (rechterkolom), of in de URL na `dash.cloudflare.com/`.
3. Ga naar **My Profile → API Tokens → Create Token** en kies het sjabloon **Workers AI**. Noteer het token.

### 2. GitHub

Zet deze map in een nieuwe repository. `node_modules` hoort er niet in (staat in `.gitignore`).

### 3. Vercel (gratis Hobby-plan)

1. **Add New → Project**, importeer de repository. Framework: *Other*. Build- en outputinstellingen leeg laten.
2. Voeg bij **Environment Variables** toe:
   - `CF_ACCOUNT_ID` = je Cloudflare Account ID
   - `CF_API_TOKEN` = het Workers AI-token
3. **Deploy.**

Controleer daarna `https://<jouw-site>/api/status`. Je hoort JSON te zien met `"ok": true`.

### 4. Referentiefoto's maken (sterk aangeraden)

Zonder referenties werkt het ook, maar het model schat dan op eigen inzicht. Met referenties vergelijkt het en wordt het oordeel veel stabieler.

1. Open `https://<jouw-site>/api/frame` op een **rustig** moment (bijvoorbeeld vroeg in de ochtend buiten het seizoen). Sla het beeld op als `referentie/leeg.jpg`.
2. Doe hetzelfde op een moment dat het terrein **vol** staat. Sla op als `referentie/vol.jpg`.
3. Commit en push. Vercel deployt vanzelf opnieuw.

Kies referenties bij daglicht en goed zicht. Verandert de camerahoek ooit, maak dan nieuwe.

## Instellingen (optioneel, via Environment Variables)

| Variabele | Standaard | Wat het doet |
|---|---|---|
| `STREAM_URL` | Veerkade-stream | HLS-playlist van de camera |
| `CF_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | Vision-model op Workers AI |
| `CF_MODEL_RESERVE` | `@cf/meta/llama-4-scout-17b-16e-instruct` | Tweede poging als het hoofdmodel faalt |
| `MEET_INTERVAL_SEC` | `240` | Meetinterval overdag |
| `NACHT_INTERVAL_SEC` | `1800` | Meetinterval 's nachts |
| `NACHT_VAN` / `NACHT_TOT` | `23` / `6` | Nachtvenster (Nederlandse tijd) |

Niveaus: rustig < 35%, gemiddeld < 65%, druk < 85%, vol vanaf 85%. Bij slecht zicht (donker, mist, storing) toont de site "Onbekend" in plaats van een gok. Aan te passen in `lib/oordeel.js`.

## Gratis blijven

- **Cloudflare:** 10.000 neurons per dag gratis. Kijk na de eerste dag bij *Workers AI* in het dashboard hoeveel er verbruikt is. Komt het in de buurt van de grens, zet `MEET_INTERVAL_SEC` op `300` of `360`. Gaat het tegoed op, dan toont de site de laatste meting tot middernacht (UTC).
- **Vercel Hobby** is bedoeld voor niet-commercieel gebruik. Gaat de site geld verdienen (advertenties, sponsoring), dan is het Pro-plan nodig.
- De CDN-cache van Vercel werkt per regio. Komen bezoekers via meerdere regio's binnen, dan kan er iets vaker gemeten worden. Voor een Nederlands publiek speelt dat nauwelijks.

## Bekende valkuil (al opgelost)

De statische ffmpeg-build crasht (segfault) als hij de tekenset-modules van het hostsysteem laadt, wat gebeurt bij MPEG-TS uit een HLS-stream. `lib/camera.js` zet daarom `GCONV_PATH` op een niet-bestaand pad. Niet weghalen.

## Nog te regelen voor livegang

- **Toestemming van de camera-eigenaar** voor hergebruik van het beeld, en de juiste naamsvermelding in de footer (`id="bron"` in `index.html`).
- Een paar dagen naast de werkelijkheid leggen: klopt "druk" met wat je op de kade ziet?

## Lokaal testen

Er is geen build-stap. Met de Vercel CLI: `npm install`, dan `vercel dev` met de twee Cloudflare-variabelen in `.env.local`.
