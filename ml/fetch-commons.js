'use strict';
// Downloads freely licensed photos of people exercising (and of people standing or sitting
// idle) from Wikimedia Commons, for teaching the model what real bodies look like.
//   node ml/fetch-commons.js
// Saves 640-px-wide copies to ml/images/<class>/ and a manifest with each photo's licence,
// author and source page for attribution. Only freely licensed photos are kept (public
// domain, CC0, CC BY, CC BY-SA). The photos never ship with the app: only the joint
// angles measured from them are used, and ml/ is excluded from deploys.
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'images');
const PER_CLASS = 55;
const MAX_BYTES = 100 * 1024 * 1024;
const UA = 'DoseLoop-ECE198-student-project/1.0 (educational exercise-tracking prototype)';

const QUERIES = {
  'Bicep curl': ['biceps curl', 'dumbbell curl', 'bicep curl dumbbell', 'arm curl exercise'],
  'Lateral arm raise': ['lateral raise', 'dumbbell lateral raise', 'arm raise exercise', 'shoulder raise dumbbell'],
  'Sit-to-stand': ['sit to stand exercise', 'chair stand exercise', 'standing up from chair', 'bodyweight squat'],
  'Seated knee extension': ['knee extension exercise', 'seated leg extension', 'seated leg raise exercise', 'chair leg extension'],
  'Standing hip abduction': ['hip abduction standing', 'side leg raise standing', 'standing leg raise exercise', 'side leg lift'],
  'Heel raise': ['calf raise', 'heel raise exercise', 'standing calf raise', 'tiptoe standing'],
  'Wall push-up': ['wall push-up', 'wall push up exercise', 'incline push-up', 'push-up against wall'],
  'Treadmill walk': ['treadmill walking', 'person walking on treadmill', 'treadmill exercise', 'walking person full body'],
  'Recumbent bike': ['recumbent bike', 'exercise bike', 'stationary bicycle exercise', 'spinning bike person'],
  Stretching: ['overhead stretch', 'arms raised stretching', 'stretching arms up', 'standing stretch exercise'],
  'Not exercising': ['elderly person standing', 'person standing full body', 'elderly person sitting on chair', 'person sitting on chair full body'],
};
const FREE = /^(public domain|pd|cc0|cc by(-sa)? [0-9.]+|cc by(-sa)?)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(params) {
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    // Rate limited: wait as long as the server asks (or back off), then try again.
    const wait = Number(res.headers.get('retry-after')) * 1000 || 4000 * (attempt + 1);
    await sleep(Math.min(wait, 30000));
  }
  return null; // give up on this request; the caller skips it
}
const strip = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestFile = path.join(OUT, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : [];
  const have = new Set(manifest.map((m) => m.title));
  let bytes = manifest.reduce((a, m) => a + (m.bytes || 0), 0);

  for (const [cls, queries] of Object.entries(QUERIES)) {
    const dir = path.join(OUT, slug(cls));
    fs.mkdirSync(dir, { recursive: true });
    let count = manifest.filter((m) => m.class === cls).length;
    const titles = [];
    for (const q of queries) {
      const r = await api({ action: 'query', list: 'search', srsearch: `${q} filetype:bitmap`, srnamespace: '6', srlimit: '40' });
      if (!r) continue;
      for (const hit of r.query.search) if (!titles.includes(hit.title) && !have.has(hit.title)) titles.push(hit.title);
      await sleep(600);
    }
    for (let i = 0; i < titles.length && count < PER_CLASS; i += 40) {
      const info = await api({ action: 'query', titles: titles.slice(i, i + 40).join('|'), prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '640' });
      if (!info) continue;
      for (const page of Object.values(info.query.pages || {})) {
        if (count >= PER_CLASS || bytes >= MAX_BYTES) break;
        const ii = page.imageinfo && page.imageinfo[0];
        if (!ii || !/^image\/(jpeg|png)$/.test(ii.mime) || !ii.thumburl) continue;
        const meta = ii.extmetadata || {};
        const license = strip(meta.LicenseShortName && meta.LicenseShortName.value);
        if (!FREE.test(license)) continue;
        const res = await fetch(ii.thumburl, { headers: { 'User-Agent': UA } });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const file = `${slug(cls)}/${String(count + 1).padStart(3, '0')}${ii.mime === 'image/png' ? '.png' : '.jpg'}`;
        fs.writeFileSync(path.join(OUT, file), buf);
        manifest.push({ file, class: cls, title: page.title, license, artist: strip(meta.Artist && meta.Artist.value).slice(0, 120), source: ii.descriptionurl, bytes: buf.length });
        have.add(page.title);
        bytes += buf.length;
        count++;
        await sleep(400);
      }
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
    console.log(`${cls.padEnd(24)} ${count} photos  (total ${(bytes / 1048576).toFixed(1)} MB)`);
    if (bytes >= MAX_BYTES) {
      console.log('Stopped at the 100 MB limit.');
      break;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
