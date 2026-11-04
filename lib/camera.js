// Camerabeeld ophalen en klaarzetten voor beoordeling.
// Alles via ffmpeg-static: werkt in een Vercel-functie zonder extra installatie.

import { spawn } from 'node:child_process';
import { readFile, rm, mkdtemp, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';

export const STREAM_URL =
  process.env.STREAM_URL ||
  'https://565c3c746b763.streamlock.net/live-cam/veerkade.stream/playlist.m3u8';

const REF_DIR = path.join(process.cwd(), 'referentie');
const REF_LEEG = path.join(REF_DIR, 'leeg.jpg');
const REF_VOL = path.join(REF_DIR, 'vol.jpg');

function ffmpeg(args, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      // De statische ffmpeg-build crasht (segfault) als hij de tekenset-modules (gconv)
      // van het hostsysteem laadt, wat gebeurt bij het lezen van MPEG-TS uit een HLS-stream.
      // Met een niet-bestaand pad faalt die lookup netjes en decodeert hij gewoon.
      env: { ...process.env, GCONV_PATH: '/nonexistent-gconv' },
    });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('Camerabeeld ophalen duurde te lang'));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg stopte met code ${code}: ${err.trim().slice(-300)}`));
    });
  });
}

async function bestaat(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function heeftReferenties() {
  return (await bestaat(REF_LEEG)) && (await bestaat(REF_VOL));
}

// Haalt het meest recente frame uit de livestream. Geeft het pad naar een JPEG terug.
async function pakFrame(werkmap) {
  const uit = path.join(werkmap, 'nu.jpg');
  await ffmpeg([
    '-rw_timeout', '15000000',        // 15 s zonder data = afbreken
    '-live_start_index', '-1',        // laatste segment, dus zo vers mogelijk
    '-i', STREAM_URL,
    '-frames:v', '1',
    '-q:v', '3',
    uit,
  ]);
  return uit;
}

// Alleen het actuele frame als JPEG (voor /api/frame en het maken van referentiefoto's).
export async function huidigFrame() {
  const werkmap = await mkdtemp(path.join(os.tmpdir(), 'frame-'));
  try {
    const nu = await pakFrame(werkmap);
    return await readFile(nu);
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}

// Masker: wit = parkeerterrein, zwart = weg (lucht, water, veerboot, stoep, randen).
// Gemaakt op 4 nov 2026 uit Pieters gele markering op een frame van 1280x720.
// UITSNEDE is het kader rond het witte deel; alleen dat gaat naar het model.
// Verandert de camerahoek, maak dan een nieuw masker en pas UITSNEDE aan.
const MASKER = path.join(REF_DIR, 'masker.png');
const UITSNEDE = { w: 1242, h: 284, x: 7, y: 378 };

// Filterketen die invoer `inLabel` maskeert (weggeknipte delen neutraal grijs) en uitsnijdt.
function maskeer(inLabel, maskerLabel, uitLabel, i) {
  const { w, h, x, y } = UITSNEDE;
  return [
    `[${inLabel}]scale=1280:720,setsar=1,format=rgba[f${i}]`,
    `[f${i}][${maskerLabel}]alphamerge[fa${i}]`,
    `color=c=0x808080:s=1280x720:d=1[g${i}]`,
    `[g${i}][fa${i}]overlay=shortest=1,crop=${w}:${h}:${x}:${y}[${uitLabel}]`,
  ];
}

// Actueel frame, klaar voor beoordeling:
//  - met masker: alleen het parkeerterrein, de rest grijs en weggesneden;
//  - met referenties: LEEG (groene rand) en VOL (rode rand) bovenin, actueel groot eronder,
//    allemaal met hetzelfde masker, zodat het model appels met appels vergelijkt.
export async function beeldenVoorMeting() {
  const werkmap = await mkdtemp(path.join(os.tmpdir(), 'meting-'));
  try {
    const nu = await pakFrame(werkmap);
    const metReferentie = await heeftReferenties();
    const metMasker = await bestaat(MASKER);
    const beoordelingPad = path.join(werkmap, 'beoordeling.jpg');

    const invoer = ['-i', nu];
    if (metReferentie) invoer.push('-i', REF_LEEG, '-i', REF_VOL);
    const maskerIndex = metReferentie ? 3 : 1;
    if (metMasker) invoer.push('-i', MASKER);

    const f = [];
    const labels = metReferentie ? ['0:v', '1:v', '2:v'] : ['0:v'];
    let bron = labels;
    if (metMasker) {
      f.push(`[${maskerIndex}:v]format=gray,scale=1280:720${labels.length > 1 ? `,split=${labels.length}` : ''}${labels.map((_, i) => `[m${i}]`).join('')}`);
      bron = labels.map((l, i) => {
        f.push(...maskeer(l, `m${i}`, `k${i}`, i));
        return `k${i}`;
      });
    }

    if (metReferentie) {
      f.push(
        `[${bron[1]}]scale=640:-2,setsar=1,pad=iw+8:ih+8:4:4:color=0x16a34a[leeg]`,
        `[${bron[2]}]scale=640:-2,setsar=1,pad=iw+8:ih+8:4:4:color=0xdc2626[vol]`,
        '[leeg][vol]hstack=inputs=2[boven]',
        `[${bron[0]}]scale=1296:-2,setsar=1[groot]`,
        '[boven][groot]vstack=inputs=2[uit]'
      );
    } else {
      f.push(`[${bron[0]}]scale=1280:-2,setsar=1[uit]`);
    }

    await ffmpeg([...invoer, '-filter_complex', f.join(';'), '-map', '[uit]', '-frames:v', '1', '-q:v', '4', beoordelingPad]);
    return { metReferentie, metMasker, beoordeling: await readFile(beoordelingPad) };
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}
