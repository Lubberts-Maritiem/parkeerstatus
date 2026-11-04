// GET /api/status
// Meet de parkeerdrukte. Vercel's CDN bewaart het antwoord een paar minuten,
// dus hoeveel bezoekers er ook zijn: de meting draait hooguit eens per interval.

import { beeldenVoorMeting } from '../lib/camera.js';
import { beoordeel, niveau } from '../lib/oordeel.js';

const INTERVAL_DAG = Number(process.env.MEET_INTERVAL_SEC || 240);  // 4 minuten
const INTERVAL_NACHT = Number(process.env.NACHT_INTERVAL_SEC || 1800); // 30 minuten
const NACHT_VAN = Number(process.env.NACHT_VAN || 23);
const NACHT_TOT = Number(process.env.NACHT_TOT || 6);

function uurInNederland(d) {
  return Number(
    new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hourCycle: 'h23' }).format(d)
  );
}

function isNacht(d) {
  const u = uurInNederland(d);
  return NACHT_VAN > NACHT_TOT ? u >= NACHT_VAN || u < NACHT_TOT : u >= NACHT_VAN && u < NACHT_TOT;
}

export default async function handler(req, res) {
  const nu = new Date();
  const interval = isNacht(nu) ? INTERVAL_NACHT : INTERVAL_DAG;

  try {
    const { metReferentie, beoordeling, voorbeeld } = await beeldenVoorMeting();
    const oordeel = await beoordeel(beoordeling, metReferentie);

    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${interval}, stale-while-revalidate=${interval * 3}`);
    res.status(200).json({
      ok: true,
      niveau: niveau(oordeel),
      ...oordeel,
      met_referentie: metReferentie,
      gemeten_op: nu.toISOString(),
      interval_s: interval,
      beeld: `data:image/jpeg;base64,${voorbeeld.toString('base64')}`,
    });
  } catch (fout) {
    // Status 200 met ok:false, zodat ook een storing kort gecachet wordt
    // en niet elke bezoeker een nieuwe poging start.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
    res.status(200).json({
      ok: false,
      niveau: 'onbekend',
      fout: String(fout?.message || fout).slice(0, 300),
      gemeten_op: nu.toISOString(),
      interval_s: 60,
    });
  }
}
