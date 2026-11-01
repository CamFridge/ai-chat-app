#!/usr/bin/env node
/**
 * 设备端 null 回归用的最小 OpenAI 兼容 SSE 服务。
 * 模拟兼容 API 常见行为：先发 role-only / content:null 的增量，再发正文。
 * 用法: node scripts/mock-sse-server.js [port]
 */
'use strict';

const http = require('http');

const PORT = Number(process.argv[2] || 8899);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    console.log(new Date().toISOString(), req.method, url, 'len=' + raw.length);
    if (req.method === 'GET' && /\/models$/.test(url)) {
      return json(res, 200, { object: 'list', data: [{ id: 'mock-null-model', object: 'model' }] });
    }
    if (req.method === 'POST' && /\/chat\/completions$/.test(url)) {
      const chunks = [
        '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}',
        '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
        '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":null,"reasoning_content":null},"finish_reason":null}]}',
        '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"，这是设备端测试回复。"},"finish_reason":null}]}',
        '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":8,"total_tokens":13}}'
      ];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.flushHeaders();
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write('data: ' + chunks[i] + '\n\n');
          i++;
          return;
        }
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 120);
      res.on('close', () => clearInterval(timer));
      return;
    }
    json(res, 404, { error: { message: 'not found: ' + url } });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock SSE server listening on http://127.0.0.1:' + PORT + ' (emulator: http://10.0.2.2:' + PORT + ')');
});
