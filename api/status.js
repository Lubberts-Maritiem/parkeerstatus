// GET /api/status
// Haalt het oordeel op bij de Cloudflare Worker en laat Vercel's CDN het een paar
// minuten bewaren. Hoeveel bezoekers er ook zijn: de Worker wordt hooguit eens per
// interval aangeroepen, en de Worker remt zelf ook nog af.

const WORKER_URL = process.env.WORKER_URL || 'https://parkeerstatus-ai.WORKERS_SUBDOMEIN.workers.dev/status';
const INTERVAL_DAG = Number(process.env.MEET_INTERVAL_SEC || 240);   // 4 minuten
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
    const r = await fetch(WORKER_URL, { signal: AbortSignal.timeout(50000) });
    const data = await r.json();
    const ok = r.ok && data?.ok === true;
    res.setHeader(
      'Cache-Control',
      ok ? `public, max-age=0, s-maxage=${interval}, stale-while-revalidate=${interval * 3}` : 'public, max-age=0, s-maxage=60'
    );
    res.status(200).json({ ...data, ok, interval_s: ok ? interval : 60 });
  } catch (fout) {
    // Status 200 met ok:false, zodat ook een storing kort gecachet wordt.
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
