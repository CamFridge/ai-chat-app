/* 设备端返回键测试：push 一个二级页 → 外部 adb keyevent 4 → 检查是否 pop 而不是退出 App。
   用法：node scripts/device-back-test.js 9333 push|check */
'use strict';
const { CdpPage } = require('./cdp.js');

const PORT = Number(process.argv[2] || 9333);
const MODE = process.argv[3] || 'push';

(async () => {
  const page = await CdpPage.connect(PORT);
  await page.init();
  if (MODE === 'push') {
    const r = await page.eval(`(function(){
      App.Router.tab('apiList');
      App.Router.push('apiEdit', {isNew:true});
      return JSON.stringify({depth: App.Router.depth()});
    })()`);
    console.log('pushed ' + r);
  } else {
    const r = await page.eval(`(function(){
      var top = document.querySelector('.navbar .navbar-title');
      return JSON.stringify({depth: App.Router.depth(), title: top ? top.textContent : '', page: (App.Router.current()||{}).name || ''});
    })()`);
    console.log('state ' + r);
  }
  process.exit(0);
})().catch((e) => { console.error(String(e && e.message || e)); process.exit(2); });
