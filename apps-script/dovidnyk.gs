/**
 * Довідник ГТ — Apps Script, що з'єднує Google Doc ↔ NotebookLM (Gemini Notebook) ↔ Hotpoint.ai.
 * Безкоштовно: відповіді дає Gemini API (free tier, ключ з aistudio.google.com), джерело — той самий Google Doc,
 * який підключено в NotebookLM. Правите документ → оновлюється і в ноутбуці, і на сайті.
 *
 * ВСТАНОВЛЕННЯ (5 хв, один раз):
 * 1. script.google.com → Новий проєкт «Довідник ГТ» → вставити цей файл.
 * 2. Налаштування проєкту (⚙) → Властивості скрипта → додати GEMINI_KEY = ключ з https://aistudio.google.com/apikey
 * 3. Вибрати функцію setup → ▶ Виконати → дозволити доступ (Документи, Таблиці, зовнішні запити).
 * 4. Розгорнути → Нове розгортання → Веб-додаток: «Виконувати від імені: я», «Доступ: усі» → скопіювати URL …/exec
 *    і надіслати Claude (або вписати в mm.html у KB_GS).
 * 5. NotebookLM → Новий ноутбук «Довідник ГТ» → Джерела → Google Диск → два документи:
 *    «Довідник ГТ — база знань…» і «Маршрути доставки ДЦ — для NotebookLM». Поділитися ноутбуком з менеджерами (перегляд).
 */
const DOC_ID   = '1VEr9AJGphtLcesIItjsDHs-f2Rc3oJ9F3kTz9iAb-as';           // «Довідник ГТ — база знань»
const SHEET_ID = '10uX5SjNpgZu3ss61UbjLQ6Jwmuwu0M-VZ1gSHBzogI8';           // таблиця з вкладкою «Доставка»
const FOLDER_ID = '1W4oMy3_ERUpbFWPcY5mILMZtBj9VjeSZ';                     // «РОЗРОБКА ШІ ХОТПОІНТ»
const ROUTES_DOC = '1GKljrC0eUdNL80w2KNiXRVVyJGiez0YbWxVSd2G1QUA';    // «Маршрути доставки ДЦ — для NotebookLM»
// безкоштовні моделі Gemini API, по черзі: якщо одна вичерпала ліміт (429) або недоступна — береться наступна
// (перевірено 26.11.2026: flash-lite відповідає за ~1 с; flash часто 503 «high demand»)
const MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-flash-latest'];
const P = PropertiesService.getScriptProperties();

// ── Веб-додаток ──
function doGet(e){
  const a = (e && e.parameter && e.parameter.action) || 'kb';
  if(a === 'kb') return out_({ ok:true, md:kbMarkdown_(), ver:kbVersion_() });
  if(a === 'ping') return out_({ ok:true, key:!!P.getProperty('GEMINI_KEY'), doc:DOC_ID });
  return out_({ ok:false, error:'невідома дія' });
}
function doPost(e){
  try{
    const b = JSON.parse(e.postData.contents || '{}');
    if(b.action === 'ask') return out_(ask_(b));
    if(b.action === 'kb') return out_({ ok:true, md:kbMarkdown_(), ver:kbVersion_() });
    return out_({ ok:false, error:'невідома дія' });
  }catch(err){ return out_({ ok:false, error:String(err.message || err) }); }
}
const out_ = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

// ── Документ як Markdown (кеш 5 хв, щоб не читати Диск на кожне питання) ──
function kbVersion_(){ return String(DriveApp.getFileById(DOC_ID).getLastUpdated().getTime()); }
function kbMarkdown_(){
  const c = CacheService.getScriptCache(), ver = kbVersion_(), k = 'kb:' + ver;
  const hit = getBig_(c, k); if(hit) return hit;
  const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + DOC_ID + '/export?mimeType=text%2Fmarkdown',
    { headers:{ Authorization:'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions:true });
  if(r.getResponseCode() !== 200) throw new Error('Не прочитав документ: ' + r.getResponseCode());
  const md = clean_(r.getContentText('UTF-8'));
  putBig_(c, k, md, 600);
  return md;
}
// CacheService тримає до 100 КБ на ключ — довгий текст ріжемо на шматки
function putBig_(c, k, s, ttl){ const o = {}; let n = 0; for(let i = 0; i < s.length; i += 40000) o[k + ':' + (n++)] = s.slice(i, i + 40000); o[k + ':n'] = String(n); c.putAll(o, ttl); }
function getBig_(c, k){ const n = +c.get(k + ':n'); if(!n) return null; const keys = []; for(let i = 0; i < n; i++) keys.push(k + ':' + i);
  const got = c.getAll(keys); let s = ''; for(const kk of keys){ if(got[kk] == null) return null; s += got[kk]; } return s; }
// експорт Google Docs екранує символи і додає порожні пункти списку — прибираємо
function clean_(s){
  return s.replace(/\\([\\`*_{}\[\]()#+\-.!>~|:=])/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (m, t, u) => t === u ? u : t + ' (' + u + ')')
    .replace(/[ \t]+\n/g, '\n').replace(/\n-\s*\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\*\s/gm, '- ').trim();
}
function cards_(md){
  return md.split(/^##\s+/m).slice(1).map((p, i) => {
    const lines = p.split('\n'), title = lines.shift().trim(), meta = {};
    while(lines.length && (/^\s*$/.test(lines[0]) || /^\s*[-*]\s*(для|розділ|питання|джерело|оновлено)\s*:/i.test(lines[0]))){
      const m = lines.shift().replace(/^\s*[-*]\s*/, '').match(/^([^:]+):\s*(.*)$/); if(m) meta[m[1].trim().toLowerCase()] = m[2].trim(); }
    return { id:i + 1, title, meta, text:lines.join('\n').trim(), staff:/персонал/i.test(meta['для'] || '') };
  });
}

// ── Відповідь на питання (як NotebookLM: лише з джерел, з номерами карток) ──
function ask_(b){
  const key = P.getProperty('GEMINI_KEY'); if(!key) return { ok:false, error:'Не вказано GEMINI_KEY у властивостях скрипта' };
  const q = String(b.q || '').slice(0, 2000).trim(); if(!q) return { ok:false, error:'Порожнє питання' };
  const staff = !!b.staff, hist = (b.history || []).slice(-6);
  const cards = cards_(kbMarkdown_()).filter(c => staff || !c.staff);
  const now = Utilities.formatDate(new Date(), 'Europe/Kiev', 'EEEE, dd.MM.yyyy HH:mm');
  const src = cards.map(c => `[${c.id}] ${c.title} (розділ: ${c.meta['розділ'] || '—'}; для: ${c.staff ? 'персоналу' : 'всіх'}; джерело: ${c.meta['джерело'] || '—'}; оновлено: ${c.meta['оновлено'] || '—'})\n${c.text}`).join('\n\n---\n\n');
  const sys = `Ти — «Довідник ГТ», розумний помічник ${staff ? 'менеджерів і директора' : 'клієнтів'} магазину «Гаряча Точка» (Львів, вул. Зелена, 238; мережа холдингу DUS Level). Працюєш як NotebookLM: твій «блокнот» — ДЖЕРЕЛА нижче. Зараз ${now} (Київ).
ЯК ВІДПОВІДАТИ:
- Спілкуйся як живий досвідчений колега: по суті, тепло, на «Ви», українською. Розумій розмовні й неточні питання, суржик, продовження розмови.
- Факти про компанію, людей, телефони, умови, строки, ціни, процедури — ТІЛЬКИ з джерел. Після кожного такого факту став номер джерела в квадратних дужках, напр. [5]. Нічого не вигадуй.
- Якщо в джерелах цього нема або стоїть «❓ ЗАПОВНИТИ» — чесно скажи «у довіднику цього ще нема» і підкажи, у кого спитати${staff ? ' (директор магазину)' : ' (менеджер або 0-800-305-777)'}.
- Можна додати загальну пораду з досвіду продажів чи сантехніки, якщо допомагає, — познач її «Порада:» і без номерів джерел; там не може бути фактів про компанію.
- ${staff ? 'Коли питають, що сказати клієнту, — дай готову фразу.' : 'Не розкривай внутрішніх правил магазину.'}
- Коротко: 2–6 речень або короткий список. Без вступів.

ДЖЕРЕЛА:
${b.route ? `[0] Маршрути доставки ДЦ (пораховано на сайті): ${String(b.route).slice(0, 1500)}\n\n---\n\n` : ''}${src}`;
  const contents = hist.map(m => ({ role:m.role === 'me' ? 'user' : 'model', parts:[{ text:String(m.text || '').slice(0, 1500) }] }));
  contents.push({ role:'user', parts:[{ text:q }] });
  const models = (P.getProperty('GEMINI_MODELS') || MODELS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  let last = '';
  for(const model of models){
    const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method:'post', contentType:'application/json', muteHttpExceptions:true, headers:{ 'x-goog-api-key':key },
      payload:JSON.stringify({ systemInstruction:{ parts:[{ text:sys }] }, contents, generationConfig:{ temperature:0, maxOutputTokens:4000 } }) });
    const code = r.getResponseCode(), j = JSON.parse(r.getContentText() || '{}');
    if(code === 200){
      const text = ((j.candidates || [])[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim() || 'У довіднику цього ще нема.';
      log_(b, q, model, text);
      return { ok:true, text, model };
    }
    last = model + ': ' + code + ' ' + (j.error && j.error.message || '');
    if(![404, 429, 500, 503].includes(code)) break;        // ліміт/недоступна — пробуємо наступну безкоштовну
  }
  return { ok:false, error:'Gemini не відповів (' + last + ')' };
}

// ── Журнал питань: що питають менеджери — підказка, що дописати в довідник ──
function log_(b, q, model, text){
  try{
    let id = P.getProperty('LOG_ID'), ss;
    if(id) ss = SpreadsheetApp.openById(id);
    else { ss = SpreadsheetApp.create('Довідник ГТ — журнал питань'); DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(FOLDER_ID));
      P.setProperty('LOG_ID', ss.getId()); ss.getSheets()[0].appendRow(['Дата', 'Хто', 'Роль', 'Питання', 'Відповідь', 'Модель', 'Без відповіді?']); }
    ss.getSheets()[0].appendRow([new Date(), b.name || '', b.staff ? 'персонал' : 'клієнт', q, text.slice(0, 2000), model, /цього ще нема/i.test(text) ? 'ТАК' : '']);
  }catch(e){}
}

// ── Маршрути доставки → окремий Google Doc для NotebookLM (оновлюється щоночі) ──
function syncRoutes(){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Доставка');
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().filter(r => r[1] && r[2]);
  const order = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'], by = {};
  for(const [route, zone, day] of rows){ const z = String(zone).trim(); if(!by[z]) by[z] = {}; if(!by[z][day]) by[z][day] = new Set(); by[z][day].add(String(route).replace(/\s+/g, ' ').trim()); }
  let id = P.getProperty('ROUTES_DOC_ID') || ROUTES_DOC, doc;
  if(id){ try{ doc = DocumentApp.openById(id); }catch(e){ id = null; } }
  if(!id){ doc = DocumentApp.create('Маршрути доставки ДЦ — для NotebookLM'); DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(FOLDER_ID)); P.setProperty('ROUTES_DOC_ID', doc.getId()); }
  const body = doc.getBody(); body.clear();
  body.appendParagraph('Маршрути доставки ДЦ Київ: у які дні машина їде в зону').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('Оновлено автоматично ' + Utilities.formatDate(new Date(), 'Europe/Kiev', 'dd.MM.yyyy HH:mm') + ' з таблиці «Hotpoint — назви, клієнти, правила, доставка», вкладка «Доставка». «Львів» без уточнення = машина на магазин ГТ Львів. Годину відсічки таблиця не знає. Назви зон — як у 1С (часто російською).');
  for(const z of Object.keys(by).sort()){
    const days = Object.keys(by[z]).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(d => d.toLowerCase() + ' (' + [...by[z][d]].join(', ') + ')');
    body.appendParagraph(z + ': ' + days.join('; '));
  }
  doc.saveAndClose();
}

// ── Запустити один раз ──
function setup(){
  syncRoutes();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncRoutes').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncRoutes').timeBased().everyDays(1).atHour(6).create();
  const md = kbMarkdown_(), n = cards_(md).length;
  Logger.log('Довідник: %s карток. Маршрути: https://docs.google.com/document/d/%s', n, P.getProperty('ROUTES_DOC_ID') || ROUTES_DOC);
  if(!P.getProperty('GEMINI_KEY')) Logger.log('⚠️ Додайте GEMINI_KEY у Властивості скрипта (ключ з https://aistudio.google.com/apikey)');
  else Logger.log('Тест: %s', JSON.stringify(ask_({ q:'До кого звернутись по видатковій?', staff:true, name:'setup' })).slice(0, 500));
}

// ── Діагностика: які безкоштовні моделі відповідають і як швидко ──
function testGemini(){
  const key = P.getProperty('GEMINI_KEY');
  for(const model of MODELS){
    const t = Date.now();
    const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', { method:'post', contentType:'application/json', muteHttpExceptions:true, headers:{ 'x-goog-api-key':key },
      payload:JSON.stringify({ contents:[{ role:'user', parts:[{ text:'Скажи «ок»' }] }], generationConfig:{ temperature:0, maxOutputTokens:50 } }) });
    Logger.log('%s → %s за %s мс: %s', model, r.getResponseCode(), Date.now() - t, r.getContentText().slice(0, 160));
  }
}
function testAsk(){
  const t = Date.now(); const r = ask_({ q:'Клієнт просить видаткову — до кого звернутись?', staff:true, name:'тест' });
  Logger.log('%s мс: %s', Date.now() - t, JSON.stringify(r).slice(0, 900));
}
