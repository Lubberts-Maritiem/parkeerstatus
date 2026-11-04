// Beoordeling van het camerabeeld door een vision-model op Cloudflare Workers AI.
// Gratis dagtegoed: 10.000 neurons per dag. Een meting kost er ruwweg 20 tot 40.

const CF_BASE = process.env.CF_BASE_URL || 'https://api.cloudflare.com/client/v4';
const MODEL = process.env.CF_MODEL || '@cf/google/gemma-4-26b-a4b-it';
const RESERVE_MODEL = process.env.CF_MODEL_RESERVE || '@cf/meta/llama-4-scout-17b-16e-instruct';

const PROMPT_MET_REFERENTIE = `You are looking at a webcam image of a public car park on a harbour quay (Veerhavenplein, West-Terschelling, the Netherlands).
The image is a composite of three photos from the same fixed camera:
- TOP LEFT, green border: reference photo of the car park when it is EMPTY.
- TOP RIGHT, red border: reference photo of the car park when it is FULL.
- BOTTOM, large: the CURRENT camera image.

Task: estimate how full the parking area is in the CURRENT image, on a scale where the EMPTY reference is 0 and the FULL reference is 100.
Rules:
- Compare the parking bays in the CURRENT image with the same area in both references.
- Only judge the parked cars. Ignore the ferry, buses, driving lanes, people and the water.
- Cars at the back hide each other. If the back rows look as densely packed as in the FULL reference, treat them as full.
- Judge visibility of the CURRENT image: "goed", "matig" (glare, rain on the lens, dusk) or "slecht" (dark, fog, lens blocked, black or frozen image).

Answer with ONLY this JSON object and nothing else:
{"bezetting_pct": <integer 0-100>, "zicht": "goed" | "matig" | "slecht", "zekerheid": "hoog" | "middel" | "laag", "toelichting": "<one short sentence in Dutch about what you see>"}`;

const PROMPT_ZONDER_REFERENTIE = `You are looking at a webcam image of a public car park on a harbour quay (Veerhavenplein, West-Terschelling, the Netherlands).

Task: estimate which percentage of the marked parking spaces is occupied by parked vehicles.
Rules:
- Only judge the block of marked parking spaces. Ignore the ferry, buses, driving lanes, people and the water. Open asphalt where cars drive is not parking space.
- Cars at the back hide each other. If the back rows look densely packed, treat them as full.
- Judge visibility: "goed", "matig" (glare, rain on the lens, dusk) or "slecht" (dark, fog, lens blocked, black or frozen image).

Answer with ONLY this JSON object and nothing else:
{"bezetting_pct": <integer 0-100>, "zicht": "goed" | "matig" | "slecht", "zekerheid": "hoog" | "middel" | "laag", "toelichting": "<one short sentence in Dutch about what you see>"}`;

const ZICHT = new Set(['goed', 'matig', 'slecht']);
const ZEKERHEID = new Set(['hoog', 'middel', 'laag']);

// Haalt het JSON-object uit het antwoord, ook als het model er tekst of codeblokken omheen zet.
export function leesAntwoord(tekst) {
  if (typeof tekst !== 'string') throw new Error('Leeg antwoord van het model');
  const kandidaten = tekst.match(/\{[^{}]*\}/g) || [];
  for (const k of kandidaten.reverse()) {
    try {
      const o = JSON.parse(k);
      if (o && o.bezetting_pct !== undefined) {
        const pct = Math.round(Number(o.bezetting_pct));
        if (!Number.isFinite(pct)) continue;
        return {
          bezetting_pct: Math.max(0, Math.min(100, pct)),
          zicht: ZICHT.has(o.zicht) ? o.zicht : 'matig',
          zekerheid: ZEKERHEID.has(o.zekerheid) ? o.zekerheid : 'laag',
          toelichting: String(o.toelichting || '').slice(0, 240),
        };
      }
    } catch {
      /* volgende kandidaat */
    }
  }
  throw new Error('Geen bruikbaar oordeel in het antwoord van het model');
}

async function vraagModel(model, jpeg, metReferentie) {
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!account || !token) throw new Error('CF_ACCOUNT_ID of CF_API_TOKEN ontbreekt');

  const res = await fetch(`${CF_BASE}/accounts/${account}/ai/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 700,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: metReferentie ? PROMPT_MET_REFERENTIE : PROMPT_ZONDER_REFERENTIE },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
          ],
        },
      ],
    }),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Workers AI ${res.status}: ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  const inhoud = data?.choices?.[0]?.message?.content;
  return leesAntwoord(Array.isArray(inhoud) ? inhoud.map((d) => d.text || '').join('') : inhoud);
}

export async function beoordeel(jpeg, metReferentie) {
  try {
    return { ...(await vraagModel(MODEL, jpeg, metReferentie)), model: MODEL };
  } catch (fout) {
    if (!RESERVE_MODEL || RESERVE_MODEL === MODEL) throw fout;
    const r = await vraagModel(RESERVE_MODEL, jpeg, metReferentie);
    return { ...r, model: RESERVE_MODEL, opmerking: `Hoofdmodel faalde: ${fout.message.slice(0, 120)}` };
  }
}

// Vertaalt het percentage naar een niveau. Bij slecht zicht geen niveau: liever eerlijk dan fout.
export function niveau({ bezetting_pct, zicht }) {
  if (zicht === 'slecht') return 'onbekend';
  if (bezetting_pct >= 85) return 'vol';
  if (bezetting_pct >= 65) return 'druk';
  if (bezetting_pct >= 35) return 'gemiddeld';
  return 'rustig';
}
