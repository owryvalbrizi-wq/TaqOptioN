#!/usr/bin/env node
'use strict';
const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path'),url=require('url');
const PORT=process.env.PORT||3000;
const JWT_SECRET=process.env.JWT_SECRET||'taqoptionke-secret-2026';
const ADMIN_KEY=process.env.ADMIN_KEY||'admin123';
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||'').toLowerCase().trim();
const MY_MPESA_NUMBER=process.env.MY_MPESA_NUMBER||'';
const USD_KES=Number(process.env.USD_KES_RATE||130);
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data');
const DB_FILE=path.join(DATA_DIR,'db.json');
const USDT_ADDRESS='TScp5kZKdMTUyEF8JgwzS7x1Ets9xiUPxi';
const ZETUPAY_SECRET_KEY=process.env.ZETUPAY_SECRET_KEY||'';
const ZETUPAY_BASE='https://pay.zetupay.co.ke/api/v1';
const ZETUPAY_PAYOUT_URL=process.env.ZETUPAY_PAYOUT_URL||'https://pay.zetupay.co.ke/api/v1/payout/b2c';
const BREVO_API_KEY=process.env.BREVO_API_KEY||'';
const EMAIL_FROM_EMAIL=process.env.EMAIL_FROM_EMAIL||'';
const EMAIL_FROM_NAME=process.env.EMAIL_FROM_NAME||'TaqOptionKe';
const INDICES={vol10:{id:'vol10',name:'Vol 10 (1s)',base:9534.43,vol:2.5,decimals:2},vol25:{id:'vol25',name:'Vol 25 (1s)',base:6355.20,vol:5,decimals:2},vol50:{id:'vol50',name:'Vol 50 (1s)',base:3428.90,vol:10,decimals:2},vol75:{id:'vol75',name:'Vol 75 (1s)',base:1854.30,vol:15,decimals:2},vol100:{id:'vol100',name:'Vol 100 (1s)',base:970.50,vol:20,decimals:2}};
let db={users:[],trades:[],txs:[],ticks:{}};
for(const id in INDICES)db.ticks[id]=[];
try{fs.mkdirSync(DATA_DIR,{recursive:true});if(fs.existsSync(DB_FILE)){const l=JSON.parse(fs.readFileSync(DB_FILE,'utf8'));Object.assign(db,l);for(const id in INDICES)if(!db.ticks[id])db.ticks[id]=[];}}catch(e){}
function save(){try{fs.writeFileSync(DB_FILE,JSON.stringify(db));}catch(e){}}
const findUser=e=>db.users.find(u=>u.email===e);
const findUserById=id=>db.users.find(u=>u.id===id);
function hashPw(pw){const s=crypto.randomBytes(16).toString('hex');return s+':'+crypto.scryptSync(pw,s,64).toString('hex');}
function checkPw(pw,stored){if(!stored||!stored.includes(':'))return false;const[s,h]=stored.split(':');try{const t=crypto.scryptSync(pw,s,64).toString('hex');return crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(t,'hex'));}catch{return false;}}
function sign(p){const d=Buffer.from(JSON.stringify({...p,exp:Date.now()+2592000000})).toString('base64url');return d+'.'+crypto.createHmac('sha256',JWT_SECRET).update(d).digest('base64url');}
function verify(t){if(!t||typeof t!=='string')return null;const[d,s]=t.split('.');if(!d||!s)return null;const exp=crypto.createHmac('sha256',JWT_SECRET).update(d).digest('base64url');if(s!==exp)return null;try{const p=JSON.parse(Buffer.from(d,'base64url').toString());return p.exp<Date.now()?null:p;}catch{return null;}}
function lastDigit(p,dec){return Math.floor(Math.abs(p)*Math.pow(10,dec))%10;}
function calcOdds(kind,pred){if(kind==='even'||kind==='odd')return 1.952;if(kind==='matches')return 9.0;if(kind==='differs')return 1.05;if(kind==='over'){const w=9-pred;if(w<=0)return 500;return +(1+(10/w-1)*0.92).toFixed(3);}if(kind==='under'){const w=pred;if(w<=0)return 500;return +(1+(10/w-1)*0.92).toFixed(3);}return 1.95;}
const resetCodes={};
async function sendEmail(to,subject,html){if(!BREVO_API_KEY||!EMAIL_FROM_EMAIL){console.log('=== EMAIL (no Brevo) ===');console.log('To:',to);console.log('Code:',(html.match(/>(\d{6})</)||[])[1]||'?');console.log('=====================');return false;}try{var r=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':BREVO_API_KEY,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({sender:{name:EMAIL_FROM_NAME,email:EMAIL_FROM_EMAIL},to:[{email:to}],subject:subject,htmlContent:html})});if(!r.ok){console.error('Brevo error:',await r.text());return false;}return true;}catch(e){console.error('Email error:',e.message);return false;}}
const state={};
for(const id in INDICES){const cfg=INDICES[id];state[id]={price:cfg.base};if(db.ticks[id].length<50){db.ticks[id]=[];let p=cfg.base;const now=Date.now();for(let i=0;i<150;i++){p=Math.max(1,p+(Math.random()-0.5)*cfg.vol);db.ticks[id].push({price:+p.toFixed(cfg.decimals),digit:lastDigit(p,cfg.decimals),time:now-(150-i)*1000});}state[id].price=p;save();}else{state[id].price=db.ticks[id][db.ticks[id].length-1].price;}}
const sseClients=new Set();
function broadcast(event,data){const payload='event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n';for(const res of sseClients){try{res.write(payload);}catch{sseClients.delete(res);}}}
setInterval(()=>{const now=Date.now();for(const id in INDICES){const cfg=INDICES[id];const s=state[id];s.price=Math.max(1,s.price+(Math.random()-0.5)*cfg.vol);const tick={price:+s.price.toFixed(cfg.decimals),digit:lastDigit(s.price,cfg.decimals),time:now};db.ticks[id].push(tick);if(db.ticks[id].length>400)db.ticks[id].shift();broadcast('tick',{index:id,tick});}},1000);
function settleTrade(t,tick){const d=tick.digit;let won=false;const odds=calcOdds(t.kind,t.prediction);switch(t.kind){case'matches':won=d===t.prediction;break;case'differs':won=d!==t.prediction;break;case'even':won=d%2===0;break;case'odd':won=d%2===1;break;case'over':won=d>t.prediction;break;case'under':won=d<t.prediction;break;}t.exitDigit=d;t.exitPrice=tick.price;t.status=won?'won':'lost';t.odds=odds;t.profit=won?+(t.stake*odds-t.stake).toFixed(2):-t.stake;t.payout=won?+(t.stake*odds).toFixed(2):0;t.settledAt=Date.now();if(won){const u=findUserById(t.userId);if(u){if(t.account==='demo')u.demoBalance=+((u.demoBalance||10000)+t.stake*odds).toFixed(2);else u.balance=+((u.balance||0)+t.stake*odds).toFixed(2);}}}
setInterval(()=>{const now=Date.now();let changed=false;db.trades.forEach(t=>{if(t.status!=='open'||t.expiresAt>now)return;const tick=db.ticks[t.index][db.ticks[t.index].length-1];if(!tick)return;settleTrade(t,tick);db.txs.push({id:crypto.randomUUID(),userId:t.userId,account:t.account,type:t.status==='won'?'trade_win':'trade_loss',amount:t.status==='won'?t.stake*t.odds:0,ref:t.id,status:'completed',createdAt:now});changed=true;});if(changed)save();},1000);
async function zetupayInitiate({phone,amountKes,reference,redirectUrl}){if(!ZETUPAY_SECRET_KEY)throw new Error('Payment gateway not configured.');const res=await fetch(ZETUPAY_BASE+'/payment/initiate',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+ZETUPAY_SECRET_KEY},body:JSON.stringify({amount:amountKes,phoneNumber:phone,reference:reference,redirectUrl:redirectUrl,currency:'KES'})});const text=await res.text();let data;try{data=JSON.parse(text);}catch{data={message:text};}if(!res.ok)throw new Error((data&&(data.message||data.error))||('Payment gateway error HTTP '+res.status));if(data.success===false)throw new Error(data.message||'Payment rejected');return data.data||data;}
async function zetupayStatus(paymentKey){try{const res=await fetch(ZETUPAY_BASE+'/payment/status/'+encodeURIComponent(paymentKey),{headers:{'Authorization':'Bearer '+ZETUPAY_SECRET_KEY}});const data=await res.json();return data&&data.success?data.data:data;}catch{return null;}}
async function zetupayPayout({amountKes,phone,reference}){if(!ZETUPAY_SECRET_KEY)throw new Error('ZetuPay key not configured');if(!phone)throw new Error('Payout phone not configured');var r=await fetch(ZETUPAY_PAYOUT_URL,{method:'POST',headers:{'Authorization':'Bearer '+ZETUPAY_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify({amount:Math.round(amountKes),phoneNumber:phone,identifier:reference})});var text=await r.text();var data;try{data=JSON.parse(text);}catch(e){data={message:text};}if(!r.ok)throw new Error((data&&(data.message||data.error))||('Payout error HTTP '+r.status));return data;}
function isAdminUser(u){return !!(u&&ADMIN_EMAIL&&u.email===ADMIN_EMAIL);}
function pub(u){return{id:u.id,name:u.name,email:u.email,balance:u.balance||0,demoBalance:u.demoBalance!=null?u.demoBalance:10000,createdAt:u.createdAt};}
function sendJSON(res,code,obj){res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function readBody(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>1e6){reject(new Error('too large'));req.destroy();}});req.on('end',()=>{if(!b)return resolve({});try{resolve(JSON.parse(b));}catch{reject(new Error('bad json'));}});req.on('error',reject);});}
function authUser(req){const h=req.headers.authorization||'';const t=h.startsWith('Bearer ')?h.slice(7):null;if(!t)return null;const p=verify(t);return p?findUserById(p.id):null;}
const CLIENT_FILE=path.join(__dirname,'client.html');
const HTML=fs.existsSync(CLIENT_FILE)?fs.readFileSync(CLIENT_FILE,'utf8'):'<!DOCTYPE html><html><head><title>TaqOptionKe</title></head><body style="background:#0a0e17;color:#fff;font-family:sans-serif;padding:40px;text-align:center"><h1>client.html missing</h1></body></html>';
const server=http.createServer(async(req,res)=>{const parsed=url.parse(req.url,true);const method=req.method;const p=parsed.pathname;res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Admin-Key');if(method==='OPTIONS'){res.writeHead(204);res.end();return;}try{const u=authUser(req);
if(p==='/healthz')return sendJSON(res,200,{ok:true,uptime:process.uptime(),zetupay:ZETUPAY_SECRET_KEY?'yes':'no',email:BREVO_API_KEY?'yes':'no',admin:ADMIN_EMAIL?'yes':'no',payout:MY_MPESA_NUMBER?'yes':'no'});
if(p==='/api/stream'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('event: init\ndata: '+JSON.stringify({indices:Object.keys(INDICES),ticks:Object.fromEntries(Object.keys(INDICES).map(id=>[id,db.ticks[id].slice(-120)]))})+'\n\n');sseClients.add(res);const ping=setInterval(()=>{try{res.write(': ping\n\n');}catch{clearInterval(ping);sseClients.delete(res);}},25000);req.on('close',()=>{clearInterval(ping);sseClients.delete(res);});return;}
if(p==='/payment/return'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment received</title><style>body{background:#0a0e17;color:#e5e7eb;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}.box{max-width:380px}.t{font-size:22px;font-weight:800;color:#22c55e;margin-bottom:10px}.s{color:#9ca3af;font-size:14px;line-height:1.6}.btn{display:inline-block;margin-top:22px;padding:13px 28px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;border-radius:11px;font-weight:800;text-decoration:none}</style></head><body><div class="box"><div class="t">Payment received</div><div class="s">Return to the app.</div><a class="btn" href="/">Return</a></div></body></html>');}
if(!p.startsWith('/api/')){if(method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(HTML);}return sendJSON(res,404,{error:'not found'});}
if(p==='/api/auth/register'&&method==='POST'){const b=await readBody(req);if(!b.name||!b.email||!b.password)return sendJSON(res,400,{error:'Missing fields'});if(b.password.length<6)return sendJSON(res,400,{error:'Password 6+ chars'});const email=(b.email||'').toLowerCase().trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return sendJSON(res,400,{error:'Invalid email'});if(findUser(email))return sendJSON(res,409,{error:'This email is already registered. Please sign in instead.'});const nu={id:crypto.randomUUID(),name:b.name,email:email,password:hashPw(b.password),balance:0,demoBalance:10000,createdAt:Date.now()};db.users.push(nu);save();return sendJSON(res,200,{token:sign({id:nu.id,email:nu.email}),user:pub(nu)});}
if(p==='/api/auth/login'&&method==='POST'){const b=await readBody(req);const user=findUser((b.email||'').toLowerCase().trim());if(!user||!checkPw(b.password,user.password))return sendJSON(res,401,{error:'Invalid email or password'});if(user.demoBalance==null){user.demoBalance=10000;save();}return sendJSON(res,200,{token:sign({id:user.id,email:user.email}),user:pub(user)});}
if(p==='/api/auth/forgot'&&method==='POST'){const b=await readBody(req);const email=(b.email||'').toLowerCase().trim();if(!email)return sendJSON(res,400,{error:'Email required'});const user=findUser(email);if(user){const existing=resetCodes[email];if(existing&&Date.now()-existing.sentAt<60000){const wait=Math.ceil((60000-(Date.now()-existing.sentAt))/1000);return sendJSON(res,429,{error:'Wait '+wait+'s before another code'});}const code=Math.floor(100000+Math.random()*900000).toString();resetCodes[email]={code:crypto.createHash('sha256').update(code).digest('hex'),expires:Date.now()+15*60*1000,attempts:0,sentAt:Date.now()};const html='<div style="font-family:sans-serif;background:#0a0e17;color:#e5e7eb;padding:32px;border-radius:12px;max-width:480px;margin:0 auto"><h1 style="color:#3b82f6;font-size:22px;margin:0 0 16px">Password Reset</h1><p>Hi '+(user.name||'there')+',</p><p>Your reset code is:</p><div style="font-size:34px;font-weight:900;letter-spacing:10px;background:#000;padding:22px;text-align:center;border-radius:8px;margin:20px 0;color:#60a5fa;font-family:monospace">'+code+'</div><p style="color:#9ca3af;font-size:13px">Expires in 15 minutes.</p></div>';const sent=await sendEmail(email,'Your TaqOptionKe reset code',html);console.log('[forgot]',email,'code:',code,'sent:',sent);}return sendJSON(res,200,{ok:true,message:'If that email exists, a code was sent. Check inbox and spam.'});}
if(p==='/api/auth/reset'&&method==='POST'){const b=await readBody(req);const email=(b.email||'').toLowerCase().trim();const code=(b.code||'').trim();const newPassword=b.password||'';if(!email||!code||!newPassword)return sendJSON(res,400,{error:'All fields required'});if(newPassword.length<6)return sendJSON(res,400,{error:'Password 6+ chars'});const entry=resetCodes[email];if(!entry)return sendJSON(res,400,{error:'No reset request found.'});if(Date.now()>entry.expires){delete resetCodes[email];return sendJSON(res,400,{error:'Code expired.'});}if(entry.attempts>=5){delete resetCodes[email];return sendJSON(res,429,{error:'Too many attempts.'});}entry.attempts++;const hash=crypto.createHash('sha256').update(code).digest('hex');if(hash!==entry.code)return sendJSON(res,400,{error:'Invalid code. '+(5-entry.attempts)+' attempts left.'});const user=findUser(email);if(!user)return sendJSON(res,404,{error:'User not found'});user.password=hashPw(newPassword);delete resetCodes[email];save();return sendJSON(res,200,{token:sign({id:user.id,email:user.email}),user:pub(user),message:'Password reset'});}
if(p==='/api/me'&&method==='GET'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});return sendJSON(res,200,pub(u));}
if(p==='/api/indices'&&method==='GET'){return sendJSON(res,200,Object.values(INDICES).map(i=>({id:i.id,name:i.name,price:db.ticks[i.id].length?db.ticks[i.id][db.ticks[i.id].length-1].price:i.base,digit:db.ticks[i.id].length?db.ticks[i.id][db.ticks[i.id].length-1].digit:0})));}
if(p==='/api/trades'&&method==='POST'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});const b=await readBody(req);const account=b.account==='demo'?'demo':'real';const stake=Number(b.stake);const duration=Math.max(1,Math.min(10,Number(b.duration)||5));if(!(stake>=0.1))return sendJSON(res,400,{error:'Min stake $0.10'});if(stake>5000)return sendJSON(res,400,{error:'Max stake $5,000'});const balance=account==='demo'?(u.demoBalance??10000):(u.balance||0);if(stake>balance)return sendJSON(res,400,{error:'Insufficient balance'});const idx=INDICES[b.index];if(!idx)return sendJSON(res,400,{error:'Unknown index'});if(!['matches','differs','even','odd','over','under'].includes(b.kind))return sendJSON(res,400,{error:'Unknown kind'});const pred=Number(b.prediction);if(['matches','differs','over','under'].includes(b.kind)&&(pred<0||pred>9||!Number.isInteger(pred)))return sendJSON(res,400,{error:'Prediction 0-9'});const tick=db.ticks[b.index][db.ticks[b.index].length-1];const odds=calcOdds(b.kind,pred);const t={id:crypto.randomUUID(),userId:u.id,account,index:b.index,kind:b.kind,prediction:pred,stake,entryDigit:tick.digit,entryPrice:tick.price,openedAt:Date.now(),expiresAt:Date.now()+duration*1000,status:'open',profit:0,odds};db.trades.push(t);if(account==='demo')u.demoBalance=+(u.demoBalance-stake).toFixed(2);else u.balance=+(u.balance-stake).toFixed(2);db.txs.push({id:crypto.randomUUID(),userId:u.id,account,type:'trade_stake',amount:-stake,ref:t.id,status:'completed',createdAt:Date.now()});save();return sendJSON(res,200,{trade:t,balance:account==='demo'?u.demoBalance:u.balance});}
if(p==='/api/trades'&&method==='GET'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});const acct=parsed.query.account;let list=db.trades.filter(t=>t.userId===u.id);if(acct==='demo'||acct==='real')list=list.filter(t=>t.account===acct);return sendJSON(res,200,list.sort((a,b)=>b.openedAt-a.openedAt).slice(0,100));}
if(p==='/api/deposits/mpesa'&&method==='POST'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});if(!ZETUPAY_SECRET_KEY)return sendJSON(res,503,{error:'M-Pesa not available.'});const b=await readBody(req);const amt=Number(b.amount);if(!(amt>=5))return sendJSON(res,400,{error:'Min $5'});const kes=Math.round(amt*USD_KES);let phone=String(b.phone||'').replace(/\D/g,'');if(phone.startsWith('0'))phone='254'+phone.slice(1);if(phone.startsWith('7')||phone.startsWith('1'))phone='254'+phone;if(!/^254[17]\d{8}$/.test(phone))return sendJSON(res,400,{error:'Invalid phone. Use 0712345678'});const txId=crypto.randomUUID();const reference='TOK'+txId.slice(0,8).toUpperCase();const proto=req.headers['x-forwarded-proto']||'https';const host=req.headers['x-forwarded-host']||req.headers.host;const redirectUrl=proto+'://'+host+'/payment/return';const tx={id:txId,userId:u.id,type:'deposit',method:'mpesa',amount:amt,kesAmount:kes,phone,reference,status:'pending',createdAt:Date.now()};db.txs.push(tx);save();try{const r=await zetupayInitiate({phone,amountKes:kes,reference,redirectUrl});tx.paymentKey=r.paymentKey||r.payment_key||r.id;tx.checkoutUrl=r.checkoutUrl||r.checkout_url;save();return sendJSON(res,200,{txId,reference,kes,checkoutUrl:tx.checkoutUrl,paymentKey:tx.paymentKey});}catch(e){tx.status='failed';tx.reason=e.message;save();return sendJSON(res,502,{error:e.message});}}
if(p==='/api/webhooks/zetupay'&&method==='POST'){try{const b=await readBody(req);if(b.event==='payment.success'&&b.data){const ref=b.data.reference;const key=b.data.paymentKey||b.data.payment_key;const tx=db.txs.find(t=>(ref&&t.reference===ref)||(key&&t.paymentKey===key));if(tx&&tx.status!=='completed'){tx.status='completed';tx.paidAt=Date.now();tx.receiptNumber=b.data.receiptNumber||b.data.receipt_number||null;const user=findUserById(tx.userId);if(user)user.balance=+((user.balance||0)+tx.amount).toFixed(2);save();}}return sendJSON(res,200,{ok:true});}catch{return sendJSON(res,200,{ok:true});}}
if(p.startsWith('/api/deposits/status/')&&method==='GET'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});const txId=p.replace('/api/deposits/status/','');const tx=db.txs.find(t=>t.id===txId&&t.userId===u.id);if(!tx)return sendJSON(res,404,{error:'Not found'});if(tx.status==='pending'&&tx.paymentKey&&ZETUPAY_SECRET_KEY){const st=await zetupayStatus(tx.paymentKey);if(st){const s=(st.status||'').toLowerCase();if((s==='success'||s==='completed'||s==='paid')&&tx.status!=='completed'){tx.status='completed';tx.paidAt=Date.now();const user=findUserById(tx.userId);if(user)user.balance=+((user.balance||0)+tx.amount).toFixed(2);save();}else if(s==='failed'||s==='cancelled'){tx.status=s;save();}}}return sendJSON(res,200,{status:tx.status,amount:tx.amount});}
if(p==='/api/deposits/crypto'&&method==='POST'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});const b=await readBody(req);const amt=Number(b.amount);if(b.currency!=='USDT_TRC20')return sendJSON(res,400,{error:'Only USDT TRC20'});if(!(amt>=5))return sendJSON(res,400,{error:'Min $5'});const ref='TOK-'+crypto.randomBytes(3).toString('hex').toUpperCase();const tx={id:crypto.randomUUID(),userId:u.id,type:'deposit',method:'crypto',currency:'USDT_TRC20',amount:amt,address:USDT_ADDRESS,reference:ref,status:'pending',createdAt:Date.now()};db.txs.push(tx);save();return sendJSON(res,200,{txId:tx.id,address:USDT_ADDRESS,reference:ref,amount:amt});}
if(p==='/api/deposits/crypto/claim'&&method==='POST'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});const b=await readBody(req);const tx=db.txs.find(t=>t.id===b.txId&&t.userId===u.id);if(!tx)return sendJSON(res,404,{error:'Not found'});tx.status='confirming';tx.claimedAt=Date.now();save();return sendJSON(res,200,{ok:true});}
if(p==='/api/transactions'&&method==='GET'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});return sendJSON(res,200,db.txs.filter(t=>t.userId===u.id).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100));}
if(p==='/api/withdrawals'&&method==='POST'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});const b=await readBody(req);const amt=Number(b.amount);if(!(amt>=10))return sendJSON(res,400,{error:'Min $10'});if(amt>(u.balance||0))return sendJSON(res,400,{error:'Insufficient balance'});if(!b.destination)return sendJSON(res,400,{error:'Destination required'});const tx={id:crypto.randomUUID(),userId:u.id,type:'withdrawal',account:'real',method:b.method,amount:amt,destination:b.destination,status:'pending',createdAt:Date.now()};db.txs.push(tx);u.balance=+(u.balance-amt).toFixed(2);save();return sendJSON(res,200,{tx,balance:u.balance});}
if(p==='/api/demo/reset'&&method==='POST'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});u.demoBalance=10000;save();return sendJSON(res,200,{demoBalance:u.demoBalance});}
if(p==='/api/admin/me'&&method==='GET'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});return sendJSON(res,200,{isAdmin:isAdminUser(u),email:u.email,adminEmail:ADMIN_EMAIL?ADMIN_EMAIL.replace(/^(.{2}).*(@.*)$/,'$1***$2'):null,myMpesa:MY_MPESA_NUMBER?MY_MPESA_NUMBER.slice(0,4)+'****'+MY_MPESA_NUMBER.slice(-3):null});}
if(p==='/api/admin/pending-withdrawals'&&method==='GET'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});if(!isAdminUser(u))return sendJSON(res,403,{error:'Admin only'});var pend=db.txs.filter(function(t){return t.type==='withdrawal'&&t.status==='pending';}).sort(function(a,b){return b.createdAt-a.createdAt;});var withU=pend.map(function(t){var usr=findUserById(t.userId);return{id:t.id,amount:t.amount,method:t.method,destination:t.destination,createdAt:t.createdAt,user:usr?{name:usr.name,email:usr.email}:null};});return sendJSON(res,200,withU);}
if(p==='/api/admin/withdraw'&&method==='POST'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});if(!isAdminUser(u))return sendJSON(res,403,{error:'Admin access required'});if(!MY_MPESA_NUMBER)return sendJSON(res,400,{error:'MY_MPESA_NUMBER not configured'});var b=await readBody(req);var amt=Number(b.amount);if(!(amt>=10))return sendJSON(res,400,{error:'Min $10'});var kes=Math.round(amt*USD_KES);var ref='ADM'+Date.now();try{var resp=await zetupayPayout({amountKes:kes,phone:MY_MPESA_NUMBER,reference:ref});db.txs.push({id:crypto.randomUUID(),userId:u.id,type:'admin_payout',account:'real',method:'mpesa',amount:amt,kesAmount:kes,phone:MY_MPESA_NUMBER,reference:ref,status:'processing',zetupay:resp,createdAt:Date.now()});save();return sendJSON(res,200,{status:'processing',reference:ref,kes:kes,zetupay_response:resp});}catch(e){return sendJSON(res,502,{error:e.message});}}
if(p.startsWith('/api/admin/approve-withdrawal/')&&method==='POST'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});if(!isAdminUser(u))return sendJSON(res,403,{error:'Admin only'});if(!MY_MPESA_NUMBER)return sendJSON(res,400,{error:'MY_MPESA_NUMBER not configured'});var wdId=p.replace('/api/admin/approve-withdrawal/','');var wd=db.txs.find(function(t){return t.id===wdId&&t.type==='withdrawal';});if(!wd)return sendJSON(res,404,{error:'Not found'});if(wd.status!=='pending')return sendJSON(res,400,{error:'Already '+wd.status});var kes2=Math.round(wd.amount*USD_KES);var ref2='WDR'+Date.now();try{var resp2=await zetupayPayout({amountKes:kes2,phone:MY_MPESA_NUMBER,reference:ref2});wd.status='processing';wd.paidAt=Date.now();wd.payoutRef=ref2;wd.zetupay=resp2;save();return sendJSON(res,200,{ok:true,reference:ref2,kes:kes2,zetupay_response:resp2});}catch(e){return sendJSON(res,502,{error:e.message});}}
if(p.startsWith('/api/admin/reject-withdrawal/')&&method==='POST'){if(!u)return sendJSON(res,401,{error:'Unauthorized'});if(!isAdminUser(u))return sendJSON(res,403,{error:'Admin only'});var wdId2=p.replace('/api/admin/reject-withdrawal/','');var wd2=db.txs.find(function(t){return t.id===wdId2&&t.type==='withdrawal';});if(!wd2)return sendJSON(res,404,{error:'Not found'});if(wd2.status!=='pending')return sendJSON(res,400,{error:'Already '+wd2.status});wd2.status='rejected';var usr2=findUserById(wd2.userId);if(usr2)usr2.balance=+((usr2.balance||0)+wd2.amount).toFixed(2);save();return sendJSON(res,200,{ok:true});}
return sendJSON(res,404,{error:'not found'});}catch(e){console.error('err:',e);try{sendJSON(res,500,{error:e.message});}catch{}}});
server.listen(PORT,()=>{console.log('\nTaqOptionKe on port '+PORT);console.log('ZetuPay:',ZETUPAY_SECRET_KEY?'configured':'NOT SET');console.log('Email (Brevo):',BREVO_API_KEY?'configured':'NOT SET');console.log('Admin:',ADMIN_EMAIL?'yes':'NOT SET');console.log('Payout M-Pesa:',MY_MPESA_NUMBER?'set':'NOT SET');console.log('Payout URL:',ZETUPAY_PAYOUT_URL);console.log('USDT:',USDT_ADDRESS);console.log('');});<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>TaqOptionKe</title>
<style>
:root{--bg:#0a0e17;--card:#131824;--card2:#1a2030;--line:rgba(255,255,255,.06);--line2:rgba(255,255,255,.1);--tx:#e5e7eb;--tx2:#9ca3af;--tx3:#6b7280;--blue:#2563eb;--blue2:#3b82f6;--green:#22c55e;--red:#ef4444;--purple:#8b5cf6;--amber:#f59e0b}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.4;-webkit-font-smoothing:antialiased;overflow-x:hidden}
button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
input,select{font-family:inherit;outline:none;border:none;background:none;color:var(--tx)}
canvas{display:block}
.mono{font-family:ui-monospace,monospace}
#authScreen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(circle at 20% 20%,rgba(37,99,235,.15),transparent 50%),radial-gradient(circle at 80% 80%,rgba(139,92,246,.12),transparent 50%)}
.auth-box{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.auth-logo{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#ef4444,#b91c1c);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;color:#fff;margin:0 auto 18px;box-shadow:0 0 24px rgba(239,68,68,.4)}
.auth-title{text-align:center;font-size:22px;font-weight:800;margin-bottom:6px}
.auth-sub{text-align:center;color:var(--tx2);font-size:13px;margin-bottom:22px}
.auth-field{margin-bottom:14px}
.auth-field label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);margin-bottom:6px}
.auth-field input{width:100%;padding:13px;background:rgba(0,0,0,.35);border:1.5px solid var(--line2);border-radius:11px;font-size:14px}
.auth-field input:focus{border-color:var(--blue2);box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.check-row{display:flex;align-items:center;gap:8px;color:var(--tx2);font-size:12px;margin:12px 0 6px;cursor:pointer}
.check-row input{width:16px;height:16px;accent-color:#3b82f6;cursor:pointer}
.auth-btn{width:100%;padding:14px;background:linear-gradient(135deg,var(--blue2),var(--blue));border-radius:11px;font-weight:800;font-size:14px;color:#fff;box-shadow:0 0 20px rgba(59,130,246,.4);margin-top:8px}
.auth-btn:disabled{opacity:.6}
.auth-switch{text-align:center;margin-top:18px;color:var(--tx2);font-size:13px}
.auth-switch button{color:var(--blue2);font-weight:700}
.auth-forgot{text-align:center;margin-top:10px}
.auth-forgot button{color:var(--tx3);font-size:12px;font-weight:600}
.auth-error{color:var(--red);font-size:12px;margin-top:10px;text-align:center;min-height:16px}
.auth-ok{color:var(--green);font-size:12px;margin-top:10px;text-align:center;min-height:16px}
.otp-input{letter-spacing:.5em;text-align:center;font-size:20px;font-weight:900;font-family:ui-monospace,monospace}
#landingPage{display:block;min-height:100vh;background:#0a0e1a;color:#e5e7eb;padding-bottom:70px;overflow-x:hidden}
#landingPage.hidden{display:none}
.lp-appbanner{display:flex;align-items:center;gap:10px;padding:10px 14px;background:linear-gradient(90deg,#1e40af,#3b82f6);color:#fff;font-size:12px;position:relative}
.lp-appbanner .ab-ic{width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:16px}
.lp-appbanner .ab-t{flex:1;min-width:0}
.lp-appbanner .ab-t b{display:block;font-size:13px;font-weight:800}
.lp-appbanner .ab-t span{opacity:.85;font-size:11px}
.lp-appbanner .ab-btn{padding:7px 14px;background:#fff;color:#1e40af;border-radius:8px;font-weight:800;font-size:12px}
.lp-appbanner .ab-x{position:absolute;top:8px;right:10px;color:rgba(255,255,255,.7);font-size:14px}
.lp-nav{display:flex;align-items:center;gap:10px;padding:14px 16px}
.lp-nav .lp-logo{display:flex;align-items:center;gap:8px;font-size:18px;font-weight:900;color:#fff}
.lp-nav .lp-logo .mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#3b82f6,#06b6d4);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff}
.lp-nav .spacer{flex:1}
.lp-nav .theme{width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;color:#e5e7eb;font-size:15px}
.lp-nav .login{color:#e5e7eb;font-size:13px;font-weight:700;padding:8px 12px}
.lp-nav .gs{padding:9px 16px;background:linear-gradient(135deg,#3b82f6,#2563eb);border-radius:9px;font-weight:800;font-size:13px;color:#fff;box-shadow:0 0 20px rgba(59,130,246,.4)}
.lp-hero{padding:32px 20px 20px;text-align:center}
.lp-badge{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:99px;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.3);color:#60a5fa;font-size:12px;font-weight:700;margin-bottom:26px}
.lp-h1{font-size:clamp(1.8rem,7vw,2.6rem);font-weight:900;line-height:1.15;color:#fff;margin-bottom:16px;letter-spacing:-.02em}
.lp-h1 .grad{background:linear-gradient(100deg,#3b82f6,#06b6d4 60%,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}
.lp-sub{color:#9ca3af;font-size:14px;line-height:1.6;max-width:420px;margin:0 auto 26px}
.lp-btn-primary{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;max-width:400px;margin:0 auto 12px;padding:16px;background:linear-gradient(135deg,#3b82f6,#2563eb);border-radius:13px;font-weight:800;font-size:15px;color:#fff;box-shadow:0 0 30px rgba(59,130,246,.4)}
.lp-btn-secondary{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;max-width:400px;margin:0 auto;padding:16px;background:rgba(255,255,255,.03);border:1.5px solid rgba(255,255,255,.15);border-radius:13px;font-weight:800;font-size:15px;color:#e5e7eb}
.lp-chips{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;padding:26px 20px 0}
.lp-chip{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:99px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.1);font-size:11px;color:#d1d5db;font-weight:700}
.lp-chip .ic{color:#3b82f6;font-size:13px}
.lp-ticker-strip{margin-top:26px;border-top:1px solid rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.06);padding:10px 0;overflow:hidden;background:rgba(0,0,0,.2)}
.lp-ticker-track{display:flex;gap:44px;white-space:nowrap;width:max-content;animation:scroll 40s linear infinite}
.lp-ticker-item{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700}
.lp-ticker-item .sym{color:#9ca3af}
.lp-ticker-item .val{color:#e5e7eb}
.lp-ticker-item .up{color:#22c55e}
.lp-ticker-item .down{color:#ef4444}
.lp-livechart{margin:18px 16px 0;background:#0f1420;border:1px solid rgba(255,255,255,.06);border-radius:14px;overflow:hidden}
.lp-lc-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06)}
.lp-lc-head .ic{width:34px;height:34px;border-radius:50%;background:#f59e0b;display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;font-size:15px;flex-shrink:0}
.lp-lc-head .info{flex:1;min-width:0}
.lp-lc-head .info .t{font-weight:800;font-size:14px;color:#fff;display:flex;align-items:center;gap:6px}
.lp-lc-head .info .t .live{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.4);border-radius:99px;font-size:9px;color:#22c55e;font-weight:800}
.lp-lc-head .info .s{font-size:11px;color:#6b7280;margin-top:2px}
.lp-lc-head .price{text-align:right}
.lp-lc-head .price .p{font-size:17px;font-weight:900;color:#22c55e}
.lp-lc-head .price .c{font-size:11px;color:#22c55e;margin-top:2px}
.lp-lc-body{position:relative;height:150px}
#lpChart{width:100%;height:100%}
.lp-live-trades{padding:16px}
.lp-live-trades h3{font-size:11px;font-weight:800;letter-spacing:.1em;color:#3b82f6;margin-bottom:12px;text-transform:uppercase}
.lp-trade-item{display:flex;align-items:center;gap:12px;padding:11px 12px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.05);border-radius:11px;margin-bottom:7px}
.lp-trade-item .arw{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:#fff;flex-shrink:0}
.lp-trade-item .arw.down{background:#ef4444}
.lp-trade-item .arw.up{background:#22c55e}
.lp-trade-item .info{flex:1;min-width:0}
.lp-trade-item .info .n{font-weight:800;font-size:13px;color:#fff}
.lp-trade-item .info .t{font-size:10px;color:#6b7280;margin-top:1px}
.lp-trade-item .amt{text-align:right}
.lp-trade-item .amt .v{font-weight:900;font-size:14px;color:#ef4444}
.lp-trade-item .amt .v.up{color:#22c55e}
.lp-trade-item .amt .d{font-size:10px;color:#6b7280;margin-top:1px}
.lp-start-btn{display:block;width:calc(100% - 32px);margin:8px 16px 0;padding:16px;background:linear-gradient(135deg,#3b82f6,#2563eb);border-radius:13px;font-weight:800;font-size:15px;color:#fff;text-align:center;box-shadow:0 0 30px rgba(59,130,246,.4)}
.lp-section{padding:60px 20px 20px}
.lp-section-tag{text-align:center;font-size:11px;font-weight:800;letter-spacing:.12em;color:#3b82f6;text-transform:uppercase;margin-bottom:12px}
.lp-section-title{text-align:center;font-size:clamp(1.5rem,6vw,2rem);font-weight:900;color:#fff;line-height:1.2;margin-bottom:32px;letter-spacing:-.02em}
.lp-feature{background:#0f1420;border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:22px;margin-bottom:12px}
.lp-feature .ic{width:44px;height:44px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:14px}
.lp-feature .ic.orange{background:rgba(245,158,11,.15);color:#f59e0b}
.lp-feature .ic.green{background:rgba(34,197,94,.15);color:#22c55e}
.lp-feature .ic.blue{background:rgba(59,130,246,.15);color:#3b82f6}
.lp-feature .ic.red{background:rgba(239,68,68,.15);color:#ef4444}
.lp-feature .ic.purple{background:rgba(139,92,246,.15);color:#8b5cf6}
.lp-feature h3{font-size:16px;font-weight:800;color:#fff;margin-bottom:8px}
.lp-feature p{color:#9ca3af;font-size:13px;line-height:1.55}
.lp-step{text-align:center;margin-bottom:20px}
.lp-step-num{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#06b6d4);display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;font-size:18px;margin:0 auto 14px;box-shadow:0 0 24px rgba(59,130,246,.5)}
.lp-step-card{background:#0f1420;border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:24px;text-align:center;margin-bottom:14px}
.lp-step-card .ic{width:48px;height:48px;border-radius:13px;background:rgba(59,130,246,.12);display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 12px;color:#60a5fa}
.lp-step-card h3{font-size:17px;font-weight:800;color:#fff;margin-bottom:8px}
.lp-step-card p{color:#9ca3af;font-size:13px;line-height:1.5}
.lp-stats{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:40px 20px 20px;text-align:center}
.lp-stat .ic{font-size:22px;color:#3b82f6;margin-bottom:8px}
.lp-stat .v{font-size:28px;font-weight:900;color:#fff;letter-spacing:-.02em;margin-bottom:4px}
.lp-stat .l{font-size:12px;color:#6b7280;font-weight:600}
.lp-test{background:#0f1420;border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:20px;margin-bottom:12px}
.lp-test .stars{color:#f59e0b;font-size:14px;margin-bottom:10px;letter-spacing:2px}
.lp-test p{color:#d1d5db;font-size:13px;line-height:1.55;margin-bottom:16px}
.lp-test .who{display:flex;align-items:center;gap:12px}
.lp-test .who .av{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;color:#fff;flex-shrink:0}
.lp-test .who .info .n{font-weight:800;font-size:13px;color:#fff}
.lp-test .who .info .c{font-size:11px;color:#6b7280;margin-top:1px}
.lp-cta-big{margin:40px 16px 20px;background:linear-gradient(135deg,#3b82f6,#2563eb 60%,#1e40af);border-radius:20px;padding:38px 24px;text-align:center;box-shadow:0 20px 60px rgba(59,130,246,.3)}
.lp-cta-big h2{font-size:clamp(1.4rem,5vw,1.7rem);font-weight:900;color:#fff;margin-bottom:10px}
.lp-cta-big p{color:rgba(255,255,255,.85);font-size:13px;margin-bottom:24px;line-height:1.5}
.lp-cta-big .btn1{display:block;width:100%;padding:15px;background:#fff;color:#1e40af;border-radius:11px;font-weight:900;font-size:14px;margin-bottom:10px}
.lp-cta-big .btn2{display:block;width:100%;padding:15px;background:rgba(255,255,255,.1);border:1.5px solid rgba(255,255,255,.25);color:#fff;border-radius:11px;font-weight:800;font-size:14px}
.lp-appdl{margin:20px 16px;background:linear-gradient(135deg,#1e40af,#3b82f6);border-radius:20px;padding:38px 24px;text-align:center;box-shadow:0 20px 60px rgba(59,130,246,.3)}
.lp-appdl .phone{width:130px;height:200px;margin:0 auto 16px;background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.3);border-radius:22px;position:relative;display:flex;align-items:center;justify-content:center}
.lp-appdl .phone .logo{width:56px;height:56px;border-radius:14px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:24px;color:#fff}
.lp-appdl .phone .badge{position:absolute;bottom:-14px;left:50%;transform:translateX(-50%);width:38px;height:38px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;box-shadow:0 0 20px rgba(34,197,94,.6);border:3px solid #0a0e1a}
.lp-appdl .android-tag{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:rgba(255,255,255,.15);border-radius:99px;color:#fff;font-size:11px;font-weight:700;margin-bottom:16px}
.lp-appdl h2{color:#fff;font-size:22px;font-weight:900;margin-bottom:10px}
.lp-appdl p{color:rgba(255,255,255,.8);font-size:13px;line-height:1.5;margin-bottom:22px}
.lp-appdl .dl-btn{display:inline-flex;align-items:center;gap:10px;padding:14px 32px;background:#fff;color:#1e40af;border-radius:13px;font-weight:900;font-size:14px}
.lp-appdl .features{display:flex;justify-content:center;gap:16px;margin-top:18px;color:rgba(255,255,255,.7);font-size:11px}
.lp-footer{padding:40px 20px 30px;text-align:center;border-top:1px solid rgba(255,255,255,.06);margin-top:30px}
.lp-footer .brand{display:inline-flex;align-items:center;gap:8px;font-size:16px;font-weight:900;color:#fff;margin-bottom:16px}
.lp-footer .brand .m{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#06b6d4);display:flex;align-items:center;justify-content:center;font-size:14px}
.lp-footer .links{display:flex;justify-content:center;gap:20px;margin-bottom:14px;font-size:12px;color:#9ca3af}
.lp-footer .copy{color:#4b5563;font-size:11px}
@keyframes scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
#app{min-height:100vh;display:none;flex-direction:column;padding-bottom:76px}
.topbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(10,14,23,.97);backdrop-filter:blur(20px);border-bottom:1px solid var(--line)}
.hamburger{width:32px;height:32px;border-radius:8px;font-size:17px;display:flex;align-items:center;justify-content:center;color:var(--tx2)}
.brand{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#ef4444,#b91c1c);display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;font-size:15px;box-shadow:0 0 16px rgba(239,68,68,.5)}
.acct-chip{display:flex;align-items:center;gap:7px;padding:5px 10px 5px 5px;border-radius:99px;background:rgba(37,99,235,.15);border:1.5px solid rgba(59,130,246,.5);font-size:12px;font-weight:800;cursor:pointer}
.acct-chip.demo{background:rgba(245,158,11,.18);border-color:rgba(245,158,11,.6);color:#fbbf24}
.acct-letter{width:24px;height:24px;border-radius:50%;background:var(--blue2);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:#fff}
.acct-chip.demo .acct-letter{background:var(--amber);color:#1a1208}
.chip-bal{font-variant-numeric:tabular-nums}
.chip-arrow{font-size:8px;opacity:.7}
.tb-spacer{flex:1}
.icon-btn{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--tx2)}
.icon-btn.on{color:var(--green)}
.dep-btn{padding:8px 14px;border-radius:9px;background:linear-gradient(135deg,var(--blue2),var(--blue));font-weight:800;font-size:12px;color:#fff;box-shadow:0 0 20px rgba(59,130,246,.4)}
.idx-scroll{display:flex;gap:6px;padding:10px 12px 4px;overflow-x:auto;scrollbar-width:none}
.idx-scroll::-webkit-scrollbar{display:none}
.idx-chip{flex-shrink:0;padding:7px 12px;border-radius:9px;background:var(--card);border:1px solid var(--line);font-size:12px;font-weight:700;color:var(--tx2)}
.idx-chip.active{background:linear-gradient(135deg,rgba(59,130,246,.2),rgba(37,99,235,.15));border-color:var(--blue2);color:var(--blue2)}
.chart-wrap{margin:10px 12px 0;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.chart-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:rgba(0,0,0,.25);border-bottom:1px solid var(--line)}
.chart-head .sym{display:flex;align-items:center;gap:10px}
.chart-head .sym-ic{width:34px;height:34px;border-radius:9px;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.25);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.chart-head .sym-info{display:flex;flex-direction:column;gap:2px;min-width:0}
.chart-head .sym-name{font-size:13px;font-weight:800;color:#fff;line-height:1.1}
.chart-head .sym-line{display:flex;align-items:center;gap:8px}
.chart-head .sym-p{font-size:13px;font-weight:700;color:#e5e7eb}
.chart-head .sym-c{font-size:12px;font-weight:700}
.chart-head .sym-c.up{color:#22c55e}
.chart-head .sym-c.down{color:#ef4444}
.hist-btn{padding:7px 14px;border-radius:99px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;font-size:12px;font-weight:800;box-shadow:0 0 16px rgba(239,68,68,.45);flex-shrink:0}
.chart-canvas{position:relative;height:230px;background:#0c1119}
#chart{width:100%;height:100%}
.chart-tools{position:absolute;left:8px;bottom:32px;display:flex;flex-direction:column;gap:6px}
.tool-sq{width:34px;height:34px;border-radius:9px;background:rgba(20,26,38,.92);border:1px solid rgba(255,255,255,.1);color:#d1d5db;font-size:17px;font-weight:700;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px)}
.tool-circle{width:38px;height:38px;border-radius:50%;background:#2dd4bf;display:flex;align-items:center;justify-content:center;box-shadow:0 0 20px rgba(45,212,191,.5);margin-top:2px}
.chart-pct{position:absolute;top:8px;right:8px;padding:5px 10px;border-radius:8px;background:rgba(20,26,38,.85);border:1px solid rgba(255,255,255,.1);color:#e5e7eb;font-size:12px;font-weight:800;backdrop-filter:blur(6px)}
.digit-ring{display:grid;grid-template-columns:repeat(10,1fr);gap:4px;padding:12px}
.digit-cell{display:flex;flex-direction:column;align-items:center;gap:3px;position:relative}
.digit-circle{width:30px;height:30px;border-radius:50%;border:2px solid var(--line2);background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;transition:all .3s}
.digit-circle.current{border-color:var(--blue2);background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;box-shadow:0 0 14px rgba(59,130,246,.7);transform:scale(1.08)}
.digit-cell.hot .digit-circle{border-color:var(--green);color:var(--green)}
.digit-cell.cold .digit-circle{border-color:var(--red);color:var(--red)}
.digit-cell.hot .digit-circle.current,.digit-cell.cold .digit-circle.current{color:#fff}
.digit-pct{font-size:9px;font-weight:700;color:var(--tx3)}
.digit-cell.hot .digit-pct{color:var(--green)}
.digit-cell.cold .digit-pct{color:var(--red)}
.digit-cell.current-cell .digit-pct{color:#60a5fa;font-weight:900}
.digit-arrow{position:absolute;bottom:-14px;left:50%;transform:translateX(-50%);font-size:11px;color:#f59e0b}
.c-tabs{display:flex;gap:6px;padding:6px 12px 0;overflow-x:auto;scrollbar-width:none}
.c-tabs::-webkit-scrollbar{display:none}
.c-tab{flex-shrink:0;display:flex;align-items:center;gap:7px;padding:8px 14px;border-radius:10px;background:var(--card);border:1px solid var(--line);font-size:12px;font-weight:700;color:var(--tx2)}
.c-tab .ti{font-size:14px;opacity:.8}
.c-tab.active{background:linear-gradient(135deg,rgba(59,130,246,.2),rgba(37,99,235,.15));border-color:var(--blue2);color:var(--blue2)}
.panel{padding:12px}
.pick-label{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);margin-bottom:6px}
.pick-row{padding:0 12px}
.digits-pick{display:grid;grid-template-columns:repeat(10,1fr);gap:5px;margin-bottom:10px}
.digits-pick button{padding:10px 2px;border-radius:9px;background:var(--card);border:1.5px solid var(--line2);font-size:15px;font-weight:800}
.digits-pick button.active{background:linear-gradient(135deg,#3b82f6,#2563eb);border-color:var(--blue2);color:#fff}
.mode-toggle{display:flex;gap:0;margin:0 12px 12px;background:#131824;border:1px solid rgba(255,255,255,.06);border-radius:11px;padding:4px}
.mode-toggle button{flex:1;padding:11px;border-radius:8px;font-weight:800;font-size:12px;letter-spacing:.08em;color:#6b7280}
.mode-toggle button.active{background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;box-shadow:0 0 16px rgba(59,130,246,.5)}
.stake-wrap{margin:0 12px 10px;background:#131824;border:1px solid rgba(59,130,246,.4);border-radius:14px;padding:12px;position:relative;box-shadow:0 0 24px rgba(59,130,246,.15),inset 0 0 24px rgba(59,130,246,.05)}
.stake-label{position:absolute;top:-8px;left:50%;transform:translateX(-50%);background:#131824;padding:0 10px;font-size:10px;font-weight:800;letter-spacing:.12em;color:#60a5fa}
.stake-row{display:flex;align-items:center;gap:8px;margin:0}
.stake-btn{width:42px;height:42px;border-radius:11px;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center}
.stake-display{flex:1;height:48px;display:flex;align-items:center;justify-content:center;gap:3px;font-size:22px;font-weight:800;background:transparent;border:none;box-shadow:none}
.stake-display .cur{font-size:17px;color:var(--blue2);font-weight:600}
.quick-amts{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;padding:0 12px 10px}
.quick-amts button{padding:9px 2px;border-radius:9px;background:var(--card);border:1px solid var(--line);font-size:11px;font-weight:800;color:var(--tx2)}
.quick-amts button.active{background:linear-gradient(135deg,rgba(59,130,246,.2),rgba(37,99,235,.15));border-color:var(--blue2);color:var(--blue2)}
.tpsl{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 12px 10px}
.tpsl-box{background:#131824;border:1px solid rgba(255,255,255,.06);border-radius:11px;padding:10px 8px;text-align:center;cursor:pointer}
.tpsl-box:active{transform:scale(.96)}
.tpsl-box .l{font-size:9px;font-weight:800;letter-spacing:.08em;margin-bottom:6px}
.tpsl-box .l.green{color:#22c55e}
.tpsl-box .l.red{color:#ef4444}
.tpsl-box .l.amber{color:#f59e0b}
.tpsl-box .v{font-size:16px;font-weight:900;color:#fff;display:flex;align-items:center;justify-content:center;gap:3px}
.tpsl-box .v .cur{font-size:12px;color:#6b7280}
.session-bar{display:flex;justify-content:space-between;align-items:center;margin:0 12px 10px;padding:10px 14px;background:linear-gradient(135deg,rgba(34,197,94,.12),rgba(59,130,246,.1));border:1px solid rgba(34,197,94,.3);border-radius:11px;font-size:12px;font-weight:800}
.session-bar span{color:#9ca3af}
.session-bar .pl-win{color:#22c55e}
.session-bar .pl-loss{color:#ef4444}
.dur-row{display:flex;gap:6px;padding:0 12px 10px;overflow-x:auto;scrollbar-width:none}
.dur-row::-webkit-scrollbar{display:none}
.dur-row button{flex-shrink:0;padding:8px 14px;border-radius:9px;background:var(--card);border:1px solid var(--line);font-size:11px;font-weight:800;color:var(--tx2)}
.dur-row button.active{background:linear-gradient(135deg,rgba(245,158,11,.2),rgba(245,158,11,.12));border-color:var(--amber);color:var(--amber)}
.trade-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 12px}
.trade-btn{padding:14px 12px;border-radius:13px;font-weight:800;text-align:left;display:flex;flex-direction:column;gap:2px}
.trade-btn .ttl{font-size:17px}
.trade-btn .sub{font-size:11px;opacity:.8;display:flex;justify-content:space-between;margin-top:3px}
.trade-btn .payout{font-size:14px;font-weight:800}
.trade-btn.green{background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;box-shadow:0 0 24px rgba(34,197,94,.4)}
.trade-btn.red{background:linear-gradient(135deg,#dc2626,#ef4444);color:#fff;box-shadow:0 0 24px rgba(239,68,68,.4)}
.trade-btn.blue{background:linear-gradient(135deg,#2563eb,#3b82f6);color:#fff;box-shadow:0 0 20px rgba(59,130,246,.4)}
.trade-btn.amber{background:linear-gradient(135deg,#d97706,#f59e0b);color:#fff}
.bnav{position:fixed;bottom:0;left:0;right:0;z-index:60;display:grid;grid-template-columns:repeat(3,1fr);background:rgba(13,18,32,.98);backdrop-filter:blur(20px);border-top:1px solid var(--line);padding:6px 6px 8px}
.bnav button{display:flex;flex-direction:column;align-items:center;gap:2px;padding:7px 4px;border-radius:9px;font-size:10px;font-weight:700;color:var(--tx3)}
.bnav button .bi{font-size:18px}
.bnav button.active{color:var(--blue2)}
.bnav button .bi svg{width:22px;height:22px;display:block}
.bnav button.active .bi svg{color:#3b82f6}
.ai-orb{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#ec4899,#8b5cf6,#3b82f6);font-size:16px;color:#fff;box-shadow:0 0 18px rgba(236,72,153,.55);transition:.25s}
.bnav button.bot-btn.active .ai-orb{transform:scale(1.08);box-shadow:0 0 26px rgba(236,72,153,.75),0 0 40px rgba(139,92,246,.4)}
.bnav button.bot-btn.active{color:#c084fc}
.view{display:none}
.view.active{display:block}
.pos-list{padding:12px;display:flex;flex-direction:column;gap:9px}
.pos-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.pos-card.won{border-color:rgba(34,197,94,.5);box-shadow:0 0 16px rgba(34,197,94,.2)}
.pos-card.lost{border-color:rgba(239,68,68,.5);box-shadow:0 0 16px rgba(239,68,68,.2)}
.pos-card .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.pos-sym{font-weight:800;font-size:13px}
.pos-badge{padding:3px 9px;border-radius:99px;font-size:9px;font-weight:800;text-transform:uppercase}
.pos-badge.won{background:rgba(34,197,94,.15);color:var(--green);border:1px solid rgba(34,197,94,.3)}
.pos-badge.lost{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}
.pos-badge.open{background:rgba(59,130,246,.15);color:var(--blue2);border:1px solid rgba(59,130,246,.3)}
.pos-meta{display:flex;justify-content:space-between;font-size:11px;color:var(--tx2);margin-top:5px}
.pos-meta b{color:var(--tx)}
.pos-meta .pl.win{color:var(--green);font-weight:800}
.pos-meta .pl.loss{color:var(--red);font-weight:800}
.empty{text-align:center;padding:50px 20px;color:var(--tx3)}
.empty .ic{font-size:40px;margin-bottom:10px;opacity:.5}
.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:100;opacity:0;pointer-events:none;transition:.28s}
.backdrop.show{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;left:0;bottom:0;width:82%;max-width:340px;background:#0d1220;z-index:110;transform:translateX(-100%);transition:transform .32s cubic-bezier(.4,0,.2,1);overflow-y:auto;box-shadow:20px 0 60px rgba(0,0,0,.6)}
.drawer.show{transform:translateX(0)}
.dr-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line)}
.dr-head .t{font-size:15px;font-weight:800}
.dr-user{display:flex;align-items:center;gap:12px;padding:16px;border-bottom:1px solid var(--line)}
.dr-user .av{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--blue2),var(--blue));display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;color:#fff}
.dr-user .info .n{font-weight:800;font-size:14px}
.dr-user .info .e{font-size:11px;color:var(--tx2);margin-top:1px}
.dr-item{display:flex;align-items:center;gap:12px;padding:14px 16px;cursor:pointer;border-bottom:1px solid var(--line)}
.dr-item .ic{width:22px;text-align:center;font-size:16px;color:var(--tx2)}
.dr-item .lbl{flex:1;font-size:13px;font-weight:600}
.dr-item.danger .ic,.dr-item.danger .lbl{color:var(--red)}
.dr-foot{padding:18px;text-align:center;color:var(--tx3);font-size:10px}
.modal{position:fixed;inset:0;z-index:200;display:none;align-items:flex-end;justify-content:center}
.modal.show{display:flex}
.modal-bg{position:absolute;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px)}
.modal-card{position:relative;width:100%;max-width:520px;background:#0d1220;border-top-left-radius:22px;border-top-right-radius:22px;max-height:88vh;overflow-y:auto;animation:slideUp .32s}
@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 10px;position:sticky;top:0;background:#0d1220;z-index:2}
.modal-head .t{font-size:18px;font-weight:800}
.modal-head .s{font-size:11px;color:var(--tx2);margin-top:2px}
.modal-body{padding:0 20px 20px}
.modal-foot{display:flex;align-items:center;justify-content:center;gap:16px;padding:12px;border-top:1px solid var(--line);color:var(--tx3);font-size:10px}
.pay-opt{display:flex;align-items:center;gap:12px;padding:14px;background:var(--card);border:1.5px solid var(--line);border-radius:13px;margin-bottom:9px;cursor:pointer}
.pay-opt.sel{border-color:var(--blue2);box-shadow:0 0 20px rgba(59,130,246,.4)}
.pay-opt .pi{width:42px;height:42px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:19px}
.pay-opt[data-m="mpesa"] .pi{background:rgba(34,197,94,.15);color:var(--green)}
.pay-opt[data-m="usdt"] .pi{background:rgba(38,161,123,.2);color:#26a17b;font-weight:900;font-size:13px}
.pay-opt .pt{flex:1}
.pay-opt .pt .n{font-weight:800;font-size:14px}
.pay-opt .pt .s{font-size:11px;color:var(--tx2);margin-top:1px}
.ff{margin-bottom:12px}
.ff label{display:block;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);margin-bottom:6px}
.ff input,.ff select{width:100%;padding:13px;background:rgba(0,0,0,.35);border:1.5px solid var(--line2);border-radius:11px;font-size:14px}
.ff select option{background:#0d1220}
.amt-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:14px}
.amt-grid button{padding:12px;border-radius:10px;background:var(--card);border:1px solid var(--line);font-size:13px;font-weight:800;color:var(--tx2)}
.amt-grid button.active{background:linear-gradient(135deg,rgba(59,130,246,.2),rgba(37,99,235,.15));border-color:var(--blue2);color:var(--blue2)}
.primary-btn{width:100%;padding:14px;border-radius:11px;background:linear-gradient(135deg,var(--blue2),var(--blue));color:#fff;font-weight:800;font-size:14px;box-shadow:0 0 20px rgba(59,130,246,.4);margin-top:4px}
.primary-btn.red{background:linear-gradient(135deg,#dc2626,#ef4444)}
.btn{padding:10px 14px;border-radius:9px;font-weight:800;font-size:12px}
.btn-g{background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.4);color:#22c55e}
.btn-r{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.4);color:#ef4444}
.btn-sm{padding:8px 12px;font-size:11px}
.result-box{padding:14px;border-radius:13px;margin-top:12px;font-size:12px;line-height:1.55}
.result-box.ok{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3)}
.result-box.warn{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3)}
.result-box .t{font-weight:800;font-size:14px;margin-bottom:6px}
.result-box .t.ok{color:var(--green)}.result-box .t.warn{color:var(--red)}
.result-box code{display:block;word-break:break-all;background:#000;padding:10px;border-radius:7px;font-family:ui-monospace,monospace;font-size:11px;margin-top:7px;color:#60a5fa;border:1px solid var(--line)}
#toast{position:fixed;bottom:96px;left:50%;transform:translate(-50%,220px);z-index:400;background:rgba(19,24,36,.98);border:1.5px solid var(--blue2);border-radius:11px;padding:11px 12px 11px 16px;font-size:13px;font-weight:800;box-shadow:0 0 26px rgba(59,130,246,.5);transition:transform .18s ease-out;max-width:90%;backdrop-filter:blur(12px);display:flex;align-items:center;gap:10px;opacity:0;pointer-events:none}
#toast.show{transform:translate(-50%,0);opacity:1;pointer-events:auto}
#toast.success{border-color:var(--green);box-shadow:0 0 26px rgba(34,197,94,.6);color:var(--green)}
#toast.error{border-color:var(--red);box-shadow:0 0 26px rgba(239,68,68,.6);color:var(--red)}
.toast-msg{flex:1;text-align:center}
.toast-x{width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.08);color:#9ca3af;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;padding:0;border:none;cursor:pointer}
.hist-item{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}
.hist-item:last-child{border-bottom:none}
.hist-ic{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:14px}
.hist-ic.win{background:rgba(34,197,94,.15);color:var(--green)}
.hist-ic.loss{background:rgba(239,68,68,.15);color:var(--red)}
.hist-ic.dep{background:rgba(59,130,246,.15);color:var(--blue2)}
.hist-ic.wd{background:rgba(245,158,11,.15);color:var(--amber)}
.hist-info{flex:1}
.hist-info .t{font-weight:700;font-size:12px}
.hist-info .s{font-size:10px;color:var(--tx3);margin-top:1px}
.hist-amt{font-weight:800;font-size:13px}
.hist-amt.pos{color:var(--green)}
.hist-amt.neg{color:var(--red)}
.bot-hero{background:linear-gradient(135deg,rgba(139,92,246,.15),rgba(59,130,246,.1));border:1px solid rgba(139,92,246,.3);border-radius:16px;padding:20px;text-align:center;margin:14px 12px 0}
.bot-hero .ic{width:60px;height:60px;border-radius:18px;background:linear-gradient(135deg,var(--purple),#c084fc);display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 12px;box-shadow:0 0 32px rgba(139,92,246,.6)}
.bot-hero h2{font-size:19px;font-weight:800;margin-bottom:4px;color:#c084fc}
.bot-hero p{color:var(--tx2);font-size:12px}
.bot-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px}
.bot-card h3{font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);margin-bottom:12px}
.bot-rec{padding:16px;border-radius:12px;text-align:center;margin-bottom:12px}
.bot-rec.even{background:linear-gradient(135deg,rgba(34,197,94,.15),rgba(34,197,94,.05));border:1.5px solid rgba(34,197,94,.5)}
.bot-rec.odd{background:linear-gradient(135deg,rgba(239,68,68,.15),rgba(239,68,68,.05));border:1.5px solid rgba(239,68,68,.5)}
.bot-rec.neutral{background:rgba(255,255,255,.03);border:1.5px solid var(--line)}
.bot-rec .lbl{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--tx3);margin-bottom:6px}
.bot-rec .val{font-size:28px;font-weight:900}
.bot-rec.even .val{color:var(--green)}
.bot-rec.odd .val{color:var(--red)}
.bot-rec .conf{font-size:11px;font-weight:700;color:var(--tx2);margin-top:8px}
.bot-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px}
.bot-stat{background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:10px;padding:10px;text-align:center}
.bot-stat .l{font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--tx3);margin-bottom:4px}
.bot-stat .v{font-size:18px;font-weight:900}
.bot-stat .v.green{color:var(--green)}
.bot-stat .v.red{color:var(--red)}
.bot-stat .v.blue{color:var(--blue2)}
.bot-stat .v.purple{color:#c084fc}
.bot-hot{display:flex;flex-wrap:wrap;gap:6px}
.bot-hot .d{padding:6px 12px;border-radius:99px;font-size:12px;font-weight:800;background:rgba(0,0,0,.3);border:1px solid var(--line)}
.bot-hot .d.hot{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.4);color:var(--green)}
.bot-hot .d.cold{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);color:var(--red)}
.bot-suggest{margin-top:12px;padding:12px;border-radius:10px;background:rgba(139,92,246,.08);border:1px solid rgba(139,92,246,.3);font-size:12px;line-height:1.55;color:var(--tx2)}
.bot-suggest b{color:#c084fc}
.result-modal{position:fixed;inset:0;z-index:500;display:none;align-items:center;justify-content:center;padding:24px}
.result-modal.show{display:flex}
.result-modal-bg{position:absolute;inset:0;background:rgba(5,8,15,.85);backdrop-filter:blur(6px)}
.result-modal-card{position:relative;width:100%;max-width:380px;background:#131824;border:1px solid rgba(255,255,255,.06);border-radius:22px;padding:32px 24px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.7);animation:popIn .28s cubic-bezier(.3,1.4,.5,1)}
@keyframes popIn{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}
.result-modal-card.win .rm-icon{background:rgba(34,197,94,.15);color:#22c55e;box-shadow:0 0 30px rgba(34,197,94,.35)}
.result-modal-card.loss .rm-icon{background:rgba(239,68,68,.15);color:#ef4444;box-shadow:0 0 30px rgba(239,68,68,.35)}
.result-modal-card.win .rm-amount{color:#22c55e;text-shadow:0 0 24px rgba(34,197,94,.5)}
.result-modal-card.loss .rm-amount{color:#ef4444;text-shadow:0 0 24px rgba(239,68,68,.5)}
.result-modal-card.win .rm-btn{background:#22c55e}
.result-modal-card.loss .rm-btn{background:#ef4444}
.rm-icon{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;margin:0 auto 20px}
.rm-title{font-size:20px;font-weight:900;color:#e5e7eb;margin-bottom:16px}
.rm-amount{font-size:32px;font-weight:900;letter-spacing:-.02em;margin-bottom:24px}
.rm-stats{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05);border-radius:14px;padding:16px 18px;margin-bottom:20px;text-align:left}
.rm-stat-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;font-size:14px;color:#9ca3af}
.rm-stat-row b{color:#e5e7eb;font-weight:800}
.rm-win{color:#22c55e}
.rm-loss{color:#ef4444}
.rm-btn{width:100%;padding:15px;border-radius:12px;font-weight:900;font-size:15px;color:#fff}
</style>
</head>
<body>

<div id="landingPage">
<div class="lp-appbanner" id="lpBanner">
<div class="ab-ic">&#11015;</div>
<div class="ab-t"><b>Get the TagOption App</b><span>Get a better trading experience</span></div>
<button class="ab-btn" onclick="lpScroll()">Download</button>
<button class="ab-x" onclick="document.getElementById('lpBanner').style.display='none'">&#10005;</button>
</div>
<div class="lp-nav">
<div class="lp-logo"><div class="mark">&#128200;</div>TagOption</div>
<div class="spacer"></div>
<button class="theme">&#9728;</button>
<button class="login" onclick="showAuth('login')">Log in</button>
<button class="gs" onclick="showAuth('register')">Get Started</button>
</div>
<div class="lp-hero">
<div class="lp-badge">&#128293; Over 1 million traders and counting</div>
<h1 class="lp-h1">Trading Made Easy,<br><span class="grad">Trade Smart</span></h1>
<p class="lp-sub">Trade 100+ assets worldwide with lightning execution and up to 95% returns. Start with as little as $10.</p>
<button class="lp-btn-primary" onclick="showAuth('register')">Get Started &mdash; It's Free <span>&#8594;</span></button>
<button class="lp-btn-secondary" onclick="showAuth('login')"><span>&#9654;</span> Try Demo</button>
</div>
<div class="lp-chips">
<div class="lp-chip"><span class="ic">&#9201;</span> &lt;1s execution</div>
<div class="lp-chip"><span class="ic">&#128176;</span> Up to 95% payout</div>
<div class="lp-chip"><span class="ic">&#128737;</span> Bank-level security</div>
<div class="lp-chip"><span class="ic">&#128179;</span> Zero fees</div>
</div>
<div class="lp-ticker-strip"><div class="lp-ticker-track" id="lpTicker"></div></div>
<div class="lp-livechart">
<div class="lp-lc-head">
<div class="ic">B</div>
<div class="info"><div class="t">BTC/USD <span class="live">LIVE</span></div><div class="s">Bitcoin / US Dollar</div></div>
<div class="price"><div class="p" id="lpPrice">$43,296.35</div><div class="c" id="lpChange">+0.09%</div></div>
</div>
<div class="lp-lc-body"><canvas id="lpChart"></canvas></div>
</div>
<div class="lp-live-trades">
<h3>Live Trades</h3>
<div id="lpTradesList"></div>
</div>
<button class="lp-start-btn" onclick="showAuth('register')">Start Trading</button>
<div class="lp-section">
<div class="lp-section-tag">Platform</div>
<h2 class="lp-section-title">Built for serious traders</h2>
<div class="lp-feature"><div class="ic orange">&#9889;</div><h3>Blazing Fast</h3><p>Trades execute in under 1 second. Zero lag, zero requotes.</p></div>
<div class="lp-feature"><div class="ic green">&#128737;</div><h3>Fully Secured</h3><p>256-bit SSL encryption and segregated client accounts.</p></div>
<div class="lp-feature"><div class="ic blue">&#127760;</div><h3>100+ Markets</h3><p>Forex, crypto, stocks, indices, commodities &mdash; all in one place.</p></div>
<div class="lp-feature"><div class="ic red">&#128176;</div><h3>No Hidden Fees</h3><p>Zero fees on deposits and withdrawals. What you see is what you get.</p></div>
<div class="lp-feature"><div class="ic blue">&#128241;</div><h3>Trade Anywhere</h3><p>Responsive web app works perfectly on any device, any screen.</p></div>
<div class="lp-feature"><div class="ic purple">&#128172;</div><h3>24/7 Support</h3><p>Real human support around the clock via live chat and email.</p></div>
</div>
<div class="lp-section">
<div class="lp-section-tag">Get Started</div>
<h2 class="lp-section-title">Three steps to your first trade</h2>
<div class="lp-step"><div class="lp-step-num">1</div></div>
<div class="lp-step-card"><div class="ic">&#128100;</div><h3>Sign Up</h3><p>Create your free account in 30 seconds. No documents needed to start.</p></div>
<div class="lp-step"><div class="lp-step-num">2</div></div>
<div class="lp-step-card"><div class="ic">&#128179;</div><h3>Deposit</h3><p>Fund with M-Pesa, crypto, or cards. Start from just $10.</p></div>
<div class="lp-step"><div class="lp-step-num">3</div></div>
<div class="lp-step-card"><div class="ic">&#127942;</div><h3>Trade &amp; Earn</h3><p>Choose an asset, predict the direction, and earn up to 95% profit.</p></div>
</div>
<div class="lp-stats">
<div class="lp-stat"><div class="ic">&#128101;</div><div class="v">1M+</div><div class="l">Active traders</div></div>
<div class="lp-stat"><div class="ic">&#128202;</div><div class="v">$2B+</div><div class="l">Total traded</div></div>
<div class="lp-stat"><div class="ic">&#127758;</div><div class="v">150+</div><div class="l">Countries</div></div>
<div class="lp-stat"><div class="ic">&#9733;</div><div class="v">4.9/5</div><div class="l">User rating</div></div>
</div>
<div class="lp-section">
<div class="lp-section-tag">Wall of Love</div>
<h2 class="lp-section-title">What traders say</h2>
<div class="lp-test"><div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div><p>"Switched from three other platforms. TagOption is the fastest and most reliable by far."</p><div class="who"><div class="av" style="background:linear-gradient(135deg,#3b82f6,#06b6d4)">AM</div><div class="info"><div class="n">Alex M.</div><div class="c">USA</div></div></div></div>
<div class="lp-test"><div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div><p>"From crypto to forex, everything in one place. The interface is buttery smooth."</p><div class="who"><div class="av" style="background:linear-gradient(135deg,#8b5cf6,#3b82f6)">SK</div><div class="info"><div class="n">Sarah K.</div><div class="c">UK</div></div></div></div>
<div class="lp-test"><div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div><p>"10 years of trading experience and this is the best platform I've ever used."</p><div class="who"><div class="av" style="background:linear-gradient(135deg,#22c55e,#06b6d4)">JW</div><div class="info"><div class="n">James W.</div><div class="c">Germany</div></div></div></div>
<div class="lp-test"><div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div><p>"Started with demo and now trade real money. Withdrawals are super fast!"</p><div class="who"><div class="av" style="background:linear-gradient(135deg,#f59e0b,#ef4444)">MG</div><div class="info"><div class="n">Maria G.</div><div class="c">Brazil</div></div></div></div>
<div class="lp-test"><div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div><p>"Sub-second execution. Perfect for my scalping strategy. Highly recommended."</p><div class="who"><div class="av" style="background:linear-gradient(135deg,#3b82f6,#a855f7)">DH</div><div class="info"><div class="n">David H.</div><div class="c">Japan</div></div></div></div>
</div>
<div class="lp-cta-big">
<h2>Ready to start earning?</h2>
<p>Join a million traders worldwide. Create your free account in under 60 seconds.</p>
<button class="btn1" onclick="showAuth('register')">Create Free Account &#8594;</button>
<button class="btn2" onclick="showAuth('login')">Try Demo</button>
</div>
<div class="lp-appdl">
<div class="phone"><div class="logo">&#128200;</div><div class="badge">&#11015;</div></div>
<div class="android-tag">&#9889; Android App Available</div>
<h2>Trade on the go</h2>
<p>Download the TagOption app. Get a better trading experience on your mobile device.</p>
<button class="dl-btn">&#11015; Download App <span>&#8594;</span></button>
<div class="features"><span>&#128737; Secure</span><span>&#9889; Lightweight</span><span>&#128276; Push Alerts</span></div>
</div>
<div class="lp-footer">
<div class="brand"><span class="m">&#128200;</span>TagOption</div>
<div class="links"><span>Privacy</span><span>Terms</span><span>Support</span></div>
<div class="copy">&copy; 2026 TagOption</div>
</div>
</div>

<div id="authScreen" style="display:none">
<div class="auth-box" id="loginBox">
<div class="auth-logo">T</div>
<h1 class="auth-title" id="authTitle">Welcome Back</h1>
<p class="auth-sub" id="authSub">Sign in to start trading digits</p>
<form id="authForm" onsubmit="return false" autocomplete="on">
<div class="auth-field" id="nameField" style="display:none"><label>Full Name</label><input type="text" id="authName" name="name" placeholder="John Doe" autocomplete="name"></div>
<div class="auth-field"><label>Email</label><input type="email" id="authEmail" name="email" placeholder="you@example.com" autocomplete="email" inputmode="email" required></div>
<div class="auth-field"><label>Password</label><input type="password" id="authPassword" name="password" placeholder="Minimum 6 characters" autocomplete="current-password" minlength="6" required></div>
<label class="check-row"><input type="checkbox" id="rememberMe" checked><span>Remember me</span></label>
<button type="submit" class="auth-btn" id="authBtn">Sign In</button>
<div class="auth-error" id="authError"></div>
</form>
<div class="auth-forgot"><button type="button" onclick="showForgot()">Forgot password?</button></div>
<p class="auth-switch"><span id="switchText">Do not have an account?</span> <button type="button" id="switchBtn">Create one</button></p>
</div>
<div class="auth-box" id="forgotBox" style="display:none">
<div class="auth-logo" style="background:linear-gradient(135deg,#3b82f6,#2563eb)">&#128273;</div>
<h1 class="auth-title" id="forgotTitle">Reset Password</h1>
<p class="auth-sub" id="forgotSub">Enter your email and we will send you a code</p>
<form id="forgotForm" onsubmit="return false">
<div id="forgotStep1">
<div class="auth-field"><label>Email</label><input type="email" id="forgotEmail" placeholder="you@example.com" autocomplete="email" inputmode="email" required></div>
<button type="submit" class="auth-btn" id="forgotSendBtn">Send Reset Code</button>
</div>
<div id="forgotStep2" style="display:none">
<div class="auth-field"><label>6-digit code</label><input type="text" id="resetCode" class="otp-input" placeholder="000000" maxlength="6" inputmode="numeric"></div>
<div class="auth-field"><label>New Password</label><input type="password" id="resetPassword" placeholder="Minimum 6 characters" autocomplete="new-password" minlength="6"></div>
<button type="submit" class="auth-btn" id="forgotResetBtn" style="background:linear-gradient(135deg,#16a34a,#22c55e)">Reset &amp; Sign In</button>
</div>
<div class="auth-error" id="forgotError"></div>
<div class="auth-ok" id="forgotOk"></div>
</form>
<div class="auth-forgot"><button type="button" onclick="hideForgot()">&#8592; Back to sign in</button></div>
</div>
</div>

<div id="app" style="display:none">
<header class="topbar">
<button class="hamburger" onclick="openDrawer()">&#9776;</button>
<div class="brand">T</div>
<button class="acct-chip" id="acctChip" onclick="openModal('acctModal')"><span class="acct-letter" id="acctLetter">R</span><span class="chip-bal" id="navBalance">$0.00</span><span class="chip-arrow">&#9660;</span></button>
<div class="tb-spacer"></div>
<button class="icon-btn on" id="soundBtn">&#128266;</button>
<button class="dep-btn" onclick="openDeposit()">Deposit</button>
</header>
<div class="idx-scroll" id="idxTabs"></div>
<div class="chart-wrap">
<div class="chart-head">
<div class="sym">
<div class="sym-ic"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="8" width="2.5" height="6" rx="0.7" fill="#60a5fa"/><rect x="6.5" y="4" width="2.5" height="10" rx="0.7" fill="#60a5fa"/><rect x="11" y="6" width="2.5" height="8" rx="0.7" fill="#60a5fa"/></svg></div>
<div class="sym-info"><div class="sym-name" id="chSym">Vol 10 (1s)</div><div class="sym-line"><span class="mono sym-p" id="chPrice">9756.78</span><span class="mono sym-c up" id="chChange">+2.70%</span></div></div>
</div>
<button class="hist-btn" onclick="toggleHistorical()">Historical View</button>
</div>
<div class="chart-canvas">
<canvas id="chart"></canvas>
<div class="chart-pct">100%</div>
<div class="chart-tools">
<button class="tool-sq" onclick="zoomChart(1)">+</button>
<button class="tool-sq" onclick="zoomChart(-1)">−</button>
<button class="tool-circle" onclick="refreshChart()"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 8a5 5 0 0 1-8.5 3.5L3 10" stroke="#0a0e17" stroke-width="1.6" stroke-linecap="round"/><path d="M13 3v3h-3M3 13v-3h3" stroke="#0a0e17" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
</div>
</div>
</div>
<div class="digit-ring" id="digitRing"></div>
<div class="c-tabs" id="cTabs">
<button class="c-tab" data-tab="matches"><span class="ti">&#9678;</span>Matches/Differs</button>
<button class="c-tab active" data-tab="evenodd"><span class="ti">&#8862;</span>Even/Odd</button>
<button class="c-tab" data-tab="overunder"><span class="ti">&#8645;</span>Over/Under</button>
</div>
<div class="panel" id="tradePanel"></div>
</div>

<div class="view" id="view-positions" style="min-height:100vh">
<div class="topbar" style="position:sticky"><button class="hamburger" onclick="switchView('trade')">&#8592;</button><div style="font-size:16px;font-weight:800;flex:1">Positions</div><div style="font-size:11px;color:var(--tx2)" id="posSummary">-</div></div>
<div class="pos-list" id="positionsList"><div class="empty"><div class="ic">&#128203;</div><div>No trades yet</div></div></div>
</div>

<div class="view" id="view-bot" style="min-height:100vh">
<div class="topbar" style="position:sticky"><button class="hamburger" onclick="switchView('trade')">&#8592;</button><div style="font-size:16px;font-weight:800;flex:1">AI Bot</div><div style="font-size:11px;color:var(--tx2)">Scans all markets</div></div>
<div class="bot-hero"><div class="ic">&#10024;</div><h2>TaqOptionKe Bot</h2><p>Scans all 5 volatilities and picks the best one for you</p></div>
<div class="bot-card">
<h3>Best market right now</h3>
<div class="bot-rec neutral" id="botRec"><div class="lbl">Scanning...</div><div class="val">-</div><div class="conf">Reading ticks...</div></div>
<div class="bot-stats">
<div class="bot-stat"><div class="l">Tab</div><div class="v green" id="botEven">-</div></div>
<div class="bot-stat"><div class="l">Best volatility</div><div class="v blue" id="botOdd">-</div></div>
<div class="bot-stat"><div class="l">Last digit</div><div class="v blue" id="botLast">-</div></div>
<div class="bot-stat"><div class="l">Confidence</div><div class="v purple" id="botConf">-</div></div>
</div>
</div>
<div class="bot-card"><h3>Digit frequency on best market</h3><div class="bot-hot" id="botDigits"></div></div>
<div class="bot-card">
<h3>Bot ranking</h3>
<div class="bot-suggest" id="botSuggest">Waiting for data...</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
<button class="trade-btn green" onclick="botApply()"><div class="ttl">Apply Bot Pick</div><div class="sub"><span>Loads best</span></div></button>
<button class="trade-btn blue" onclick="renderBot()"><div class="ttl">Refresh</div><div class="sub"><span>Re-scan</span></div></button>
</div>
</div>
</div>

<nav class="bnav">
<button class="active" data-view="trade" onclick="switchView('trade')"><span class="bi"><svg width="22" height="22" viewBox="0 0 22 22"><rect x="3" y="12" width="3" height="7" rx="1" fill="currentColor"/><rect x="9.5" y="6" width="3" height="13" rx="1" fill="currentColor"/><rect x="16" y="9" width="3" height="10" rx="1" fill="currentColor"/></svg></span><span>Trade</span></button>
<button class="bot-btn" data-view="bot" onclick="switchView('bot')"><span class="bi ai-orb">&#10024;</span><span>AI</span></button>
<button data-view="positions" onclick="switchView('positions')"><span class="bi"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M11 6.5V11l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span><span>Positions</span></button>
</nav>

<div class="backdrop" id="drawerBackdrop" onclick="closeDrawer()"></div>
<aside class="drawer" id="drawer">
<div class="dr-head"><span class="t">Menu</span><button onclick="closeDrawer()">&#10005;</button></div>
<div class="dr-user"><div class="av" id="drawerAvatar">U</div><div class="info"><div class="n" id="drawerName">Guest</div><div class="e" id="drawerEmail">not signed in</div></div></div>
<div class="dr-item" onclick="closeDrawer();openDeposit()"><span class="ic">&#11015;</span><span class="lbl">Deposit</span></div>
<div class="dr-item" onclick="closeDrawer();openWithdraw()"><span class="ic">&#11014;</span><span class="lbl">Withdraw</span></div>
<div class="dr-item" onclick="closeDrawer();openHistory()"><span class="ic">&#128336;</span><span class="lbl">History</span></div>
<div class="dr-item" id="adminItem" style="display:none" onclick="closeDrawer();openAdminPanel()"><span class="ic">&#128273;</span><span class="lbl">Admin Panel</span></div>
<div class="dr-item" onclick="closeDrawer();resetDemo()"><span class="ic">&#127918;</span><span class="lbl">Reset Demo Balance</span></div>
<div class="dr-item danger" onclick="logout()"><span class="ic">&#9211;</span><span class="lbl">Log out</span></div>
<div class="dr-foot mono" id="drTime"></div>
</aside>

<div class="modal" id="acctModal"><div class="modal-bg" onclick="closeModal('acctModal')"></div><div class="modal-card" style="max-width:400px;border-radius:16px;margin:auto"><div class="modal-head"><div><div class="t">Choose Account</div><div class="s">Switch between real and demo</div></div><button onclick="closeModal('acctModal')">&#10005;</button></div><div class="modal-body"><div class="pay-opt" data-acct="real" onclick="setAccount('real')"><div class="pi" style="background:rgba(37,99,235,.15);color:var(--blue2)">R</div><div class="pt"><div class="n">Real Account</div><div class="s">Balance: <span id="realBal">$0.00</span></div></div><div class="pa" id="realCheck">&#9675;</div></div><div class="pay-opt" data-acct="demo" onclick="setAccount('demo')"><div class="pi" style="background:rgba(245,158,11,.15);color:var(--amber)">D</div><div class="pt"><div class="n">Demo Account</div><div class="s">Balance: <span id="demoBal">$10,000.00</span></div></div><div class="pa" id="demoCheck">&#9675;</div></div></div></div></div>

<div class="modal" id="depositModal"><div class="modal-bg" onclick="closeModal('depositModal')"></div><div class="modal-card"><div class="modal-head"><div><div class="t">Deposit Funds</div><div class="s">Choose your payment method</div></div><button onclick="closeModal('depositModal')">&#10005;</button></div><div class="modal-body"><div class="pay-opt sel" data-m="mpesa" onclick="pickPay(this)"><div class="pi">&#128241;</div><div class="pt"><div class="n">M-Pesa</div><div class="s">Instant mobile money</div></div><div class="pa">&#8599;</div></div><div class="pay-opt" data-m="usdt" onclick="pickPay(this)"><div class="pi">&#8366;</div><div class="pt"><div class="n">USDT (TRC20)</div><div class="s">Cryptocurrency - TRON</div></div><div class="pa">&#8599;</div></div><div class="ff" style="margin-top:14px"><label>Amount (USD)</label><input type="number" id="depAmount" value="10" min="5" oninput="updateDepAmts()"></div><div class="amt-grid" id="depAmtGrid"><button data-amt="5" onclick="setDepAmt(this,5)">$5</button><button data-amt="10" class="active" onclick="setDepAmt(this,10)">$10</button><button data-amt="25" onclick="setDepAmt(this,25)">$25</button><button data-amt="50" onclick="setDepAmt(this,50)">$50</button><button data-amt="100" onclick="setDepAmt(this,100)">$100</button><button data-amt="250" onclick="setDepAmt(this,250)">$250</button></div><div class="ff" id="mpesaPhoneField"><label>M-Pesa Phone Number</label><input type="tel" id="mpesaPhone" placeholder="0712345678"></div><button class="primary-btn" onclick="submitDeposit()">Continue</button><div id="depositResult"></div></div><div class="modal-foot"><span>Secure</span><span>Instant</span><span>24/7</span></div></div></div>

<div class="modal" id="withdrawModal"><div class="modal-bg" onclick="closeModal('withdrawModal')"></div><div class="modal-card"><div class="modal-head"><div><div class="t">Withdraw Funds</div><div class="s">Real account only</div></div><button onclick="closeModal('withdrawModal')">&#10005;</button></div><div class="modal-body"><div class="ff"><label>Withdraw To</label><select id="wdMethod"><option value="mpesa">M-Pesa</option><option value="usdt">USDT (TRC20)</option></select></div><div class="ff"><label>Destination</label><input type="text" id="wdDest" placeholder="0712345678 or TRC20 address"></div><div class="ff"><label>Amount (USD)</label><input type="number" id="wdAmount" value="10" min="10"></div><button class="primary-btn red" onclick="submitWithdraw()">Request Withdrawal</button><div id="withdrawResult"></div></div><div class="modal-foot"><span>24h processing</span><span>Zero fees</span></div></div></div>

<div class="modal" id="historyModal"><div class="modal-bg" onclick="closeModal('historyModal')"></div><div class="modal-card"><div class="modal-head"><div><div class="t">History</div><div class="s">Your transactions</div></div><button onclick="closeModal('historyModal')">&#10005;</button></div><div class="modal-body" id="historyBody"><div class="empty"><div class="ic">&#128203;</div><div>No history yet</div></div></div></div></div>

<div class="modal" id="adminModal">
<div class="modal-bg" onclick="closeModal('adminModal')"></div>
<div class="modal-card">
<div class="modal-head"><div><div class="t">Admin Panel</div><div class="s">Payouts &amp; approvals</div></div><button onclick="closeModal('adminModal')">&#10005;</button></div>
<div class="modal-body">
<div style="border:1px solid rgba(59,130,246,.3);border-radius:14px;padding:16px;margin-bottom:16px;background:rgba(59,130,246,.05)">
<div class="pick-label">Withdraw to my M-Pesa</div>
<div class="ff"><label>Amount (USD)</label><input type="number" id="admAmount" value="10" min="10"></div>
<div class="ff"><label>My M-Pesa number (fixed)</label><input type="text" id="admPhone" readonly style="background:rgba(0,0,0,.5);color:#60a5fa"></div>
<button class="primary-btn" onclick="adminWithdraw()">Send to my M-Pesa</button>
<div id="admResult"></div>
</div>
<h3 style="font-size:12px;font-weight:800;letter-spacing:.08em;color:var(--tx3);text-transform:uppercase;margin-bottom:10px">Pending user withdrawals</h3>
<div id="admPendingList"><div class="empty" style="padding:20px"><div>No pending</div></div></div>
</div>
</div>
</div>

<div class="result-modal" id="resultModal">
<div class="result-modal-bg" onclick="hideResult()"></div>
<div class="result-modal-card" id="rmCard">
<div class="rm-icon" id="rmIcon">&#10003;</div>
<h2 class="rm-title" id="rmTitle">Target Profit Hit! &#127881;</h2>
<div class="rm-amount" id="rmAmount">+0.00 USD</div>
<div class="rm-stats">
<div class="rm-stat-row"><span>Total Trades:</span><b id="rmTrades">0</b></div>
<div class="rm-stat-row"><span>Wins / Losses:</span><b><span class="rm-win" id="rmWins">0W</span> / <span class="rm-loss" id="rmLosses">0L</span></b></div>
<div class="rm-stat-row"><span>Win Rate:</span><b id="rmRate">0.0%</b></div>
</div>
<button class="rm-btn" id="rmBtn" onclick="hideResult()">Close</button>
</div>
</div>

<div id="toast"></div>
