// GET /api/beeld
// Het beeld dat de Cloudflare Worker laat beoordelen: actueel camerabeeld, met
// (als ze bestaan) de referentiefoto's leeg en vol erboven. Header X-Met-Referentie
// vertelt de Worker welke vraag hij moet stellen.

import { beeldenVoorMeting } from '../lib/camera.js';

export default async function handler(req, res) {
  try {
    // ?twee=1: de Worker kent de prompt voor twee camera's en wil de Havenkom erbij.
    // Een oudere Worker vraagt dat niet en krijgt het beeld zoals voorheen.
    const twee = new URL(req.url, 'http://x').searchParams.get('twee') === '1';
    const { metReferentie, metHavenkom, beoordeling } = await beeldenVoorMeting({ havenkom: twee });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Met-Referentie', metReferentie ? '1' : '0');
    res.setHeader('X-Met-Havenkom', metHavenkom ? '1' : '0');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
    res.status(200).send(beoordeling);
  } catch (fout) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ ok: false, fout: String(fout?.message || fout).slice(0, 300) });
  }
}
