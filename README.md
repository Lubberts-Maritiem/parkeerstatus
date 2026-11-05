# Parkeren op de Haven

Indicatieve parkeerdrukte op het Veerhavenplein, West-Terschelling. Volledig gratis: **Vercel (Hobby)** voor de site en het camerabeeld, een **Cloudflare Worker** met het gratis dagtegoed van **Workers AI** voor het oordeel. Er is nergens een API-sleutel nodig.

## Hoe het werkt

```
bezoeker ─► index.html ─► /api/status (Vercel, CDN-cache 5 min)
                               │
                               ▼
                    Cloudflare Worker (AI-binding)
                               │ haalt zelf het beeld op
                               ▼
                     /api/beeld (Vercel, ffmpeg)
                     actueel frame + referenties leeg/vol
```

1. `index.html` toont de livestream en een statuskaart: rustig, gemiddeld, druk of vol.
2. `/api/status` vraagt het oordeel op bij de Worker. Vercel's CDN bewaart het 5 minuten, 's nachts (23:00 tot 06:00) 30 minuten.
3. De Worker haalt `/api/beeld` op: het actuele frame, met de referentiefoto's leeg en vol erboven als die er zijn. Een vision-model zegt waar het beeld zit tussen leeg (0) en vol (100).
4. De Worker gebruikt de **AI-binding** van Cloudflare, dus geen token. Hij accepteert geen eigen invoer, haalt alleen het beeld van de vaste Vercel-URL, en meet hooguit eens per 4 minuten en 40 seconden. Zo kan niemand je gratis tegoed opmaken.
5. Speelt de livestream niet af, dan toont de pagina een stilstaand frame via `/api/frame` dat elke minuut ververst. Mislukt een meting, dan blijft de laatste geslaagde meting staan met een melding.

## Onderdelen

| Bestand | Wat |
|---|---|
| `index.html` | De site |
| `api/status.js` | Doorgeefluik naar de Worker, met CDN-cache |
| `api/beeld.js` | Samengesteld beeld voor de beoordeling |
| `api/frame.js` | Actueel camerabeeld als JPEG |
| `lib/camera.js` | ffmpeg: frame pakken en samenstellen |
| `worker/worker.js` | De Cloudflare Worker (prompt, modellen, rem) |
| `referentie/` | `masker.png` (wat het model wel en niet ziet), `leeg.jpg` en `vol.jpg` |

## Worker aanpassen

De Worker staat in Cloudflare onder **Workers & Pages → parkeerstatus-ai**. Wijzig je `worker/worker.js`, plak de nieuwe code dan via **Edit code** en klik **Deploy**. De Worker heeft twee bindings: **Workers AI** (variabelenaam `AI`) en **KV namespace** `parkeerstatus-cache` (variabelenaam `CACHE`). Via KV delen alle exemplaren van de Worker de laatste meting, zodat er nooit dubbel gemeten wordt. Zonder `CACHE` werkt de Worker ook, maar dan remt elk exemplaar alleen zichzelf.

## Masker

`referentie/masker.png` (1280x720, wit = parkeerterrein) knipt lucht, water, veerboot, stoep en randen weg. Alleen het kader rond het witte deel gaat naar het model (`UITSNEDE` in `lib/camera.js`). Referentiefoto's krijgen hetzelfde masker. Verandert de camerahoek, maak dan een nieuw masker en pas `UITSNEDE` aan.

## Referentiefoto's (sterk aangeraden)

Zonder referenties werkt het ook, maar het model schat dan op eigen inzicht.

1. Open `https://<jouw-site>/api/frame` op een **rustig** moment en sla het beeld op als `referentie/leeg.jpg`.
2. Doe hetzelfde als het terrein **vol** staat: `referentie/vol.jpg`.
3. Commit en push. Vercel deployt vanzelf.

Kies daglicht en goed zicht. Verandert de camerahoek, maak dan nieuwe.

## Instellingen (optioneel, Environment Variables in Vercel)

| Variabele | Standaard | Wat het doet |
|---|---|---|
| `WORKER_URL` | in `api/status.js` | Adres van de Worker |
| `STREAM_URL` | Veerkade-stream | HLS-playlist van de camera |
| `MEET_INTERVAL_SEC` | `300` | Cache-duur overdag |
| `NACHT_INTERVAL_SEC` | `1800` | Cache-duur 's nachts |
| `NACHT_VAN` / `NACHT_TOT` | `23` / `6` | Nachtvenster (Nederlandse tijd) |

Niveaus: rustig < 35%, gemiddeld < 65%, druk < 85%, vol vanaf 85%. Bij slecht zicht toont de site "Onbekend". Aan te passen in `worker/worker.js`.

## Gratis blijven

- **Cloudflare:** 10.000 neurons per dag gratis. Gemeten op 4 november: een meting met Llama 4 Scout kost ongeveer 28 neurons. Met 5 minuten overdag en 30 minuten 's nachts is dat hooguit zo'n 6.000 per dag. De rem in de Worker (280 s) houdt het ook in het slechtste geval onder de 8.700. Verbruik staat bij *Workers AI → Usage*. KV gebruikt ongeveer 2 schrijfacties per meting, ruim binnen de gratis 1.000 per dag.
- Let op: elke keer dat je de Worker-editor in het dashboard opent, voert het voorbeeldvenster daar een meting uit.
- Gemma 4 (`@cf/google/gemma-4-26b-a4b-it`) gaf geen bruikbaar JSON-antwoord en is daarom uit de modellijst gehaald.
- **Vercel Hobby** is voor niet-commercieel gebruik. Gaat de site geld verdienen, dan is Pro nodig.

## Bekende valkuil (al opgelost)

De statische ffmpeg-build crasht (segfault) als hij de tekenset-modules van het hostsysteem laadt, wat gebeurt bij MPEG-TS uit een HLS-stream. `lib/camera.js` zet daarom `GCONV_PATH` op een niet-bestaand pad. Niet weghalen.

## Nog te regelen voor livegang

- **Toestemming van de camera-eigenaar** (Heel Holland Kijkt, via hun contactpagina). De naamsvermelding staat op de site: onder het camerabeeld en in de footer.
- Een paar dagen naast de werkelijkheid leggen: klopt "druk" met wat je op de kade ziet?
