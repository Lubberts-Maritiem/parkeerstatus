// Camerabeeld ophalen en klaarzetten voor beoordeling.
// Alles via ffmpeg-static: werkt in een Vercel-functie zonder extra installatie.

import { spawn } from 'node:child_process';
import { readFile, rm, mkdtemp, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';

export const STREAM_URL =
  process.env.STREAM_URL ||
  'https://5b8d2cbe62ad6.streamlock.net/live/veerkade.stream/playlist.m3u8';

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

// Actueel frame plus:
//  - beoordeling: een compositie met bovenin LEEG (groene rand) en VOL (rode rand),
//    onderin groot het actuele beeld. Een enkel beeld, dus het werkt met elk vision-model.
//  - voorbeeld: verkleind actueel beeld om op de site te tonen als de stream wegvalt.
export async function beeldenVoorMeting() {
  const werkmap = await mkdtemp(path.join(os.tmpdir(), 'meting-'));
  try {
    const nu = await pakFrame(werkmap);
    const metReferentie = await heeftReferenties();
    const beoordelingPad = path.join(werkmap, 'beoordeling.jpg');
    const voorbeeldPad = path.join(werkmap, 'voorbeeld.jpg');

    if (metReferentie) {
      const filter = [
        '[1:v]scale=640:360,setsar=1,pad=648:368:4:4:color=0x16a34a[leeg]',
        '[2:v]scale=640:360,setsar=1,pad=648:368:4:4:color=0xdc2626[vol]',
        '[leeg][vol]hstack=inputs=2[boven]',
        '[0:v]split=2[a][b]',
        '[a]scale=1296:729,setsar=1[groot]',
        '[boven][groot]vstack=inputs=2[grid]',
        '[b]scale=640:-2[klein]',
      ].join(';');
      await ffmpeg([
        '-i', nu, '-i', REF_LEEG, '-i', REF_VOL,
        '-filter_complex', filter,
        '-map', '[grid]', '-frames:v', '1', '-q:v', '4', beoordelingPad,
        '-map', '[klein]', '-frames:v', '1', '-q:v', '6', voorbeeldPad,
      ]);
    } else {
      await ffmpeg([
        '-i', nu,
        '-filter_complex', '[0:v]split=2[a][b];[a]scale=1280:-2[groot];[b]scale=640:-2[klein]',
        '-map', '[groot]', '-frames:v', '1', '-q:v', '4', beoordelingPad,
        '-map', '[klein]', '-frames:v', '1', '-q:v', '6', voorbeeldPad,
      ]);
    }

    return {
      metReferentie,
      beoordeling: await readFile(beoordelingPad),
      voorbeeld: await readFile(voorbeeldPad),
    };
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}
