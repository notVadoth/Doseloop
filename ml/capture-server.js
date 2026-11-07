'use strict';
// Local helper for building training data in the browser (local use only, 127.0.0.1:4199):
//   POST /            save a MediaPipe recording made by the figure capture to ml/data/
//   GET  /images/...  serve the downloaded photos (ml/images/) to the page
//   POST /stills      save pose measurements read from those photos to ml/stills.json
//   node ml/capture-server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, 'data');
const IMAGES = path.join(__dirname, 'images');
fs.mkdirSync(DATA, { recursive: true });

http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:4198');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.end();

    if (req.method === 'GET' && req.url.startsWith('/images/')) {
      const file = path.resolve(IMAGES, decodeURIComponent(req.url.slice('/images/'.length)));
      if (!file.startsWith(IMAGES + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
      const type = file.endsWith('.json') ? 'application/json' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method !== 'POST') return res.writeHead(405).end();

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const rec = JSON.parse(body);
        if (req.url === '/stills') {
          fs.writeFileSync(path.join(__dirname, 'stills.json'), JSON.stringify(rec));
          console.log(`saved stills.json: ${rec.length} photos`);
          return res.end(JSON.stringify({ saved: 'stills.json' }));
        }
        const name = `${String(rec.label).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${String(rec.run).replace(/[^A-Za-z0-9]+/g, '')}.json`;
        fs.writeFileSync(path.join(DATA, name), JSON.stringify(rec));
        console.log(`saved ${name}: ${rec.frames.length} frames`);
        res.end(JSON.stringify({ saved: name }));
      } catch (e) {
        res.writeHead(400).end(String(e.message));
      }
    });
  })
  .listen(4199, '127.0.0.1', () => console.log('capture server on http://127.0.0.1:4199'));
