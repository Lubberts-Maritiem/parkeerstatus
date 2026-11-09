// GET /api/frame
// Geeft het actuele camerabeeld als JPEG. Handig om de referentiefoto's te maken:
// open deze URL op een rustig en op een vol moment en sla het beeld op als
// referentie/leeg.jpg en referentie/vol.jpg.

import { huidigFrame } from '../lib/camera.js';

export default async function handler(req, res) {
  try {
    // ?cam=havenkom geeft het frame van de tweede camera (stilstaand beeld op de site).
    const havenkom = new URL(req.url, 'http://x').searchParams.get('cam') === 'havenkom';
    const jpeg = await huidigFrame({ havenkom });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
    res.status(200).send(jpeg);
  } catch (fout) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ ok: false, fout: String(fout?.message || fout).slice(0, 300) });
  }
}
