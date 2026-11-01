#!/usr/bin/env node
'use strict';
const { CdpPage } = require('./cdp');
const PORT = Number(process.argv[2] || 9333);

(async () => {
  const page = await CdpPage.connect(PORT);
  await page.init();
  const r1 = await page.eval(`(async () => {
    const p = await App.DB.get('providers','prov_mock');
    const out = { baseUrl: p && p.baseUrl, chatUrl: p ? App.API.chatUrl(p.baseUrl) : null, bridge: App.Bridge.available };
    try { const t = await App.API.testProvider(p); out.test = { ok: t.ok, models: t.models }; } catch(e) { out.testErr = String(e); }
    return out;
  })()`);
  console.log('diag1', JSON.stringify(r1));
  const r2 = await page.eval(`(function(){
    return new Promise(function(resolve){
      var evs = [];
      var h = App.Bridge.stream({ baseUrl:'http://127.0.0.1:8899/v1', apiKey:'sk-device-123456', model:'mock-null-model', messages:[{role:'user',content:'你好'}], params:{temperature:0.5,max_tokens:50}, timeoutMs:15000 }, function(ev){ evs.push(ev.type + ':' + (ev.text||'')); if(ev.type==='done'||ev.type==='error') resolve({evs:evs, ev:ev}); });
      setTimeout(function(){ try{h.abort();}catch(e){} resolve({evs:evs, timeout:true}); }, 12000);
    });
  })()`);
  console.log('diag2', JSON.stringify(r2));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
