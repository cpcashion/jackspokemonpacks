import { chromium } from 'playwright';
const B='http://127.0.0.1:48375';
const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await br.newPage({viewport:{width:390,height:844}});
const errs=[], fails=[];
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text().slice(0,120));});
p.on('response',r=>{ if(r.status()>=400) fails.push(`HTTP ${r.status()} ${r.url().replace(B,'')}`); });

const step = async (label, fn) => {
  const before = errs.length + fails.length;
  try { await fn(); } catch (e) { errs.push(`${label} THREW: ${e.message.slice(0,100)}`); }
  const added = errs.length + fails.length - before;
  console.log(`  ${added ? '✗' : '✓'} ${label}`);
};

await p.goto(B,{waitUntil:'networkidle'});
await p.waitForSelector('.card');

await step('search filters the collection', async () => {
  await p.fill('#search','Charizard'); await p.waitForTimeout(500);
  await p.fill('#search',''); await p.waitForTimeout(400);
});
await step('sort by each column', async () => {
  for (const s of await p.$$('[data-sort]')) { await s.click(); await p.waitForTimeout(250); }
});
await step('sets view opens and expands', async () => {
  await p.click('.nav-item[data-view="sets"]'); await p.waitForSelector('.set');
  await p.click('.set'); await p.waitForTimeout(500);
});
await step('types grouping', async () => {
  await p.click('[data-group="types"]'); await p.waitForTimeout(900);
});
await step('unpriced tab', async () => {
  await p.click('.nav-item[data-view="review"]'); await p.waitForTimeout(900);
});
await step('settings + books + health', async () => {
  await p.click('.nav-item[data-view="settings"]'); await p.waitForTimeout(2200);
});
await step('card sheet opens with provenance', async () => {
  await p.click('.nav-item[data-view="collection"]'); await p.waitForSelector('.card');
  await p.click('.card'); await p.waitForSelector('#provenancePanel'); await p.waitForTimeout(1200);
});
await step('chart ranges inside the sheet', async () => {
  for (const b of await p.$$('.sheet-ranges button, [data-card-range]')) { await b.click(); await p.waitForTimeout(200); }
});
await step('close the sheet', async () => {
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
});

console.log(`\n  errors  : ${errs.length ? '\n    '+errs.slice(0,8).join('\n    ') : 'none'}`);
console.log(`  bad HTTP: ${fails.length ? '\n    '+[...new Set(fails)].slice(0,8).join('\n    ') : 'none'}`);
await br.close();
