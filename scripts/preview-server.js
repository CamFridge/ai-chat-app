/* 本地静态预览服务器（仅开发/验证用，不进入 APK）。
   用法：node scripts/preview-server.js [port]
   默认 http://127.0.0.1:8321 ，根目录 = android/assets/www */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'android', 'assets', 'www');
const port = Number(process.argv[2] || 8321);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.faq': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + p);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log('preview: http://127.0.0.1:' + port + '/  (root=' + root + ')');
});
