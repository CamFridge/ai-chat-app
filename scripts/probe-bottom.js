const path=require('path');
const {CdpPage}=require('./cdp');
(async()=>{
 const p=await CdpPage.connect(9222); await p.init();
 await p.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true,screenWidth:390,screenHeight:844});
 await p.navigate('http://127.0.0.1:8321/index.html?x='+Date.now(),1200);
 await new Promise(r=>setTimeout(r,600));
 await p.eval(`(async()=>{for(let i=0;i<80&&!(window.App&&App.DB&&App.Router);i++)await new Promise(r=>setTimeout(r,50));
  await App.DB.ready; App.Router.tab('chatList'); await new Promise(r=>setTimeout(r,300));
  App.Router.push('chat',{sessionId:'sess_o'}); await new Promise(r=>setTimeout(r,900));
  const l=document.querySelector('.chat-msg-list'); l.scrollTop=l.scrollHeight;
  const msgs=[...l.querySelectorAll('.msg')].map(m=>({id:m.dataset.id,cls:m.className,top:Math.round(m.getBoundingClientRect().top),h:Math.round(m.getBoundingClientRect().height),txt:(m.textContent||'').slice(0,20)}));
  return msgs;})()`).then(r=>console.log(JSON.stringify(r,null,1)));
 await new Promise(r=>setTimeout(r,400));
 await p.screenshot(path.join(__dirname,'build','shots','overlap-bottom.png'),{width:390,height:844});
 // 裁剪底部区域
 const {execSync}=require('child_process');
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
