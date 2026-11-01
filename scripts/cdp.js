/* 极简 Chrome DevTools Protocol 客户端（零依赖，Node 22+ 自带 WebSocket/fetch）。
   仅用于开发期在无头 Chrome 里加载 www 做冒烟测试与截图。 */
'use strict';

class CdpPage {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const hs = this.handlers.get(msg.method);
        if (hs) for (const h of hs) { try { h(msg.params); } catch (e) { console.error('handler error', e); } }
      }
    });
  }

  static async connect(port, { targetUrlIncludes } = {}) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const targets = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const t = targetUrlIncludes ? (targets.find((x) => (x.url || '').includes(targetUrlIncludes)) || targets[0]) : targets[0];
    if (!t) throw new Error('没有可用的 page target');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    return new CdpPage(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 30000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    const consoleMsgs = [];
    const exceptions = [];
    const logs = [];
    this.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
      consoleMsgs.push({ level: p.type, text });
    });
    this.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      exceptions.push({
        text: (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown',
        url: d.url, line: d.lineNumber
      });
    });
    this.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      logs.push({ level: e.level, text: e.text, url: e.url, line: e.lineNumber });
    });
    this.collect = { consoleMsgs, exceptions, logs };
    return this.collect;
  }

  async clearStorage(origin) {
    await this.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  }

  async navigate(url, waitMs = 1600) {
    this.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, waitMs));
  }

  async eval(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue, userGesture: true
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval 异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }

  async screenshot(file, { width = 390, height = 844 } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: true,
      screenWidth: width, screenHeight: height
    });
    await new Promise((r) => setTimeout(r, 250));
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }
}

module.exports = { CdpPage };
