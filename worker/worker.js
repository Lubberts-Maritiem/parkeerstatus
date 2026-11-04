// Cloudflare Worker: beoordeelt het camerabeeld met Workers AI.
// Gebruikt de AI-binding (variabelenaam: AI), dus er is geen API-token nodig.
//
// De Worker haalt het beeld zelf op bij de Vercel-site (vaste URL hieronder) en
// accepteert geen eigen invoer. Hij kan dus niet misbruikt worden als gratis AI-dienst.
// Daarnaast draait hij hooguit eens per MIN_INTERVAL_MS een meting; tussendoor geeft
// hij de vorige uitkomst terug. Zo blijft het gratis dagtegoed veilig.

const BEELD_URL = 'https://parkeerstatus.vercel.app/api/beeld';
const MODELLEN = ['@cf/meta/llama-4-scout-17b-16e-instruct'];
const MIN_INTERVAL_MS = 280_000; // ~28 neurons per meting: max ~310 per dag = ~8.700 neurons

const PROMPT_MET_REFERENTIE = `You are looking at a webcam image of a public car park on a harbour quay (Veerhavenplein, West-Terschelling, the Netherlands).
The image is a composite of three photos from the same fixed camera:
- TOP LEFT, green border: reference photo of the car park when it is EMPTY.
- TOP RIGHT, red border: reference photo of the car park when it is FULL.
- BOTTOM, large: the CURRENT camera image.

Task: estimate how full the parking area is in the CURRENT image, on a scale where the EMPTY reference is 0 and the FULL reference is 100.
Rules:
- Flat grey areas are masked out on purpose. Ignore them: only the visible part is the car park.
- Compare the parking bays in the CURRENT image with the same area in both references.
- Only judge the parked cars. Ignore the ferry, buses, driving lanes, people and the water.
- Cars at the back hide each other. If the back rows look as densely packed as in the FULL reference, treat them as full.
- Judge visibility of the CURRENT image: "goed", "matig" (glare, rain on the lens, dusk) or "slecht" (dark, fog, lens blocked, black or frozen image).

Answer with ONLY this JSON object and nothing else:
{"bezetting_pct": <integer 0-100>, "zicht": "goed" | "matig" | "slecht", "zekerheid": "hoog" | "middel" | "laag", "toelichting": "<one short sentence in Dutch about what you see>"}`;

const PROMPT_ZONDER_REFERENTIE = `You are looking at a webcam image of a public car park on a harbour quay (Veerhavenplein, West-Terschelling, the Netherlands).

Task: estimate which percentage of the marked parking spaces is occupied by parked vehicles.
Rules:
- Flat grey areas are masked out on purpose. Ignore them: only the visible part is the car park.
- Only judge the area with parked cars and marked parking spaces. Ignore the ferry, buses, driving lanes, people and the water. Open asphalt where cars drive is not parking space.
- Cars at the back hide each other. If the back rows look densely packed, treat them as full.
- Judge visibility: "goed", "matig" (glare, rain on the lens, dusk) or "slecht" (dark, fog, lens blocked, black or frozen image).

Answer with ONLY this JSON object and nothing else:
{"bezetting_pct": <integer 0-100>, "zicht": "goed" | "matig" | "slecht", "zekerheid": "hoog" | "middel" | "laag", "toelichting": "<one short sentence in Dutch about what you see>"}`;

const ZICHT = new Set(['goed', 'matig', 'slecht']);
const ZEKERHEID = new Set(['hoog', 'middel', 'laag']);

export function leesAntwoord(tekst) {
  if (tekst && typeof tekst === 'object') tekst = JSON.stringify(tekst);
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

export function niveau({ bezetting_pct, zicht }) {
  if (zicht === 'slecht') return 'onbekend';
  if (bezetting_pct >= 85) return 'vol';
  if (bezetting_pct >= 65) return 'druk';
  if (bezetting_pct >= 35) return 'gemiddeld';
  return 'rustig';
}

function naarBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function tekstUit(out) {
  if (typeof out === 'string') return out;
  if (out?.response !== undefined) return out.response;
  const c = out?.choices?.[0]?.message?.content;
  if (Array.isArray(c)) return c.map((d) => d.text || '').join('');
  return c;
}

async function meet(env) {
  const r = await fetch(`${BEELD_URL}?t=${Date.now()}`, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`Camerabeeld niet beschikbaar (${r.status})`);
  const metReferentie = r.headers.get('x-met-referentie') === '1';
  const dataUrl = `data:image/jpeg;base64,${naarBase64(await r.arrayBuffer())}`;
  const prompt = metReferentie ? PROMPT_MET_REFERENTIE : PROMPT_ZONDER_REFERENTIE;

  const fouten = [];
  for (const model of MODELLEN) {
    try {
      const out = await env.AI.run(model, {
        temperature: 0.1,
        max_tokens: 700,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      });
      const oordeel = leesAntwoord(tekstUit(out));
      return { ok: true, niveau: niveau(oordeel), ...oordeel, model, met_referentie: metReferentie, opmerking: fouten.length ? fouten.join(' | ') : undefined };
    } catch (e) {
      fouten.push(`${model.split('/').pop()}: ${String(e?.message || e).slice(0, 140)}`);
    }
  }
  throw new Error(fouten.join(' | '));
}

let laatste = null; // { t, body }
let bezig = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/' && url.pathname !== '/status') return new Response('Niet gevonden', { status: 404 });

    const nu = Date.now();
    if (!laatste || nu - laatste.t >= MIN_INTERVAL_MS) {
      const p = (bezig ??= meet(env)
        .then((res) => ({ t: Date.now(), body: { ...res, gemeten_op: new Date().toISOString() } }))
        .catch((e) => ({ t: Date.now() - MIN_INTERVAL_MS + 60_000, body: { ok: false, niveau: 'onbekend', fout: String(e?.message || e).slice(0, 400), gemeten_op: new Date().toISOString() } }))
        .finally(() => { bezig = null; }));
      laatste = await p;
    }
    return new Response(JSON.stringify(laatste.body), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
};
