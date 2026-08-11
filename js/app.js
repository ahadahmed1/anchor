/* ---- Categories ----
   Drives labels/nouns/extra fields per life area. Adding a category later is a config
   edit here, not new rendering code. */
const CATEGORY_ORDER = ['software','home','car','health','finance','appliances','yard','digital'];
const CATEGORIES = {
  software:   { label:'Software',      color:'cyan',  groupNoun:'Epic',      itemNoun:'Story', domainFields:[], groupFields:[], itemFields:[] },
  home:       { label:'Home',          color:'amber', groupNoun:'Area',      itemNoun:'Task',  domainFields:[{key:'address',label:'Address',type:'text'}], groupFields:[], itemFields:[] },
  car:        { label:'Car',           color:'slate', groupNoun:'Vehicle',   itemNoun:'Task',  domainFields:[], groupFields:[
                  {key:'make',label:'Make',type:'text'},{key:'model',label:'Model',type:'text'},
                  {key:'year',label:'Year',type:'text'},{key:'plate',label:'Plate',type:'text'}
                ], itemFields:[{key:'currentMileage',label:'Current mileage',type:'number'}] },
  health:     { label:'Health',        color:'green', groupNoun:'Person',    itemNoun:'Item',  domainFields:[], groupFields:[], itemFields:[{key:'provider',label:'Provider',type:'text'}] },
  finance:    { label:'Finance/Admin', color:'amber', groupNoun:'Account',   itemNoun:'Item',  domainFields:[], groupFields:[], itemFields:[
                  {key:'account',label:'Account',type:'text'},{key:'cost',label:'Cost',type:'text'}
                ] },
  appliances: { label:'Appliances',    color:'slate', groupNoun:'Appliance', itemNoun:'Task',  domainFields:[], groupFields:[], itemFields:[] },
  yard:       { label:'Yard',          color:'green', groupNoun:'Area',      itemNoun:'Task',  domainFields:[], groupFields:[], itemFields:[] },
  digital:    { label:'Digital/Admin', color:'cyan',  groupNoun:'Service',   itemNoun:'Item',  domainFields:[], groupFields:[], itemFields:[{key:'account',label:'Account / service',type:'text'}] }
};
function catOf(domain){ return CATEGORIES[domain && domain.category] || CATEGORIES.software; }

const STATUS_ORDER = ['not_started','in_progress','blocked','done'];
const STATUS_LABEL = {not_started:'Not started', in_progress:'In progress', blocked:'Blocked', done:'Done'};
const HEALTH_LABEL = {attention:'Attention', on_track:'On track', done:'Done'};
const DUE_LABEL = {overdue:'Overdue', due_soon:'Due soon', upcoming:'Upcoming', unknown:'—', done:'Done'};
const RECUR_UNIT_LABEL = {days:'day(s)', weeks:'week(s)', months:'month(s)', years:'year(s)', miles:'mile(s)'};

let domains = [];
let currentHealthFilter = 'all';   // all | attention | on_track | done
let currentCatFilter = 'all';      // all | software | home | ...
let globalView = 'list';           // 'list' | 'board'
let groupViewMode = 'tree';        // 'tree' | 'board' (for whichever domain page is open)
let expandedItems = new Set();
let searchTerm = '';
let editingField = null;           // fieldKey of the single field currently in edit mode (text input, chip picker, or popover), or null
let extraFieldsExpanded = new Set(); // pathKeys whose category-specific extra fields are expanded from summary into individual fields
let logDetailsOpen = new Set();    // item ids whose "add details" (note/cost/mileage) panel is expanded for the next log entry
let domainPageHealthFilter = 'all'; // 'all'|'attention'|'on_track'|'done' — scoped to whichever domain page is open
let domainPageGroupFilter = 'all';  // 'all'|groupId — scoped to whichever domain page is open
let tasksDatePreset = 'all';       // 'all'|'today'|'tomorrow'|'week'|'month'|'custom'
let tasksCustomFrom = null;
let tasksCustomTo = null;
let tasksCatFilter = 'all';        // 'all'|category key, scoped to the Tasks board

const grid = document.getElementById('grid');
const ledgerStrip = document.getElementById('ledgerStrip');
const catChips = document.getElementById('catChips');
const toastEl = document.getElementById('toast');
const healthTabsEl = document.getElementById('healthTabs');
const domainsWidgetsEl = document.getElementById('domainsWidgets');

/* ---- Hash routing ----
   #/domain/<id> -> domain detail page, #/tasks -> global tasks board, anything else -> domains list/board. */
function currentRoute(){
  const h = location.hash || '';
  const m = h.match(/^#\/domain\/(.+)$/);
  if(m) return {view:'domain', id: decodeURIComponent(m[1])};
  if(h === '#/tasks') return {view:'tasks'};
  return {view:'domains'};
}
function openDomainPage(id){
  domainPageHealthFilter = 'all';
  domainPageGroupFilter = 'all';
  groupViewMode = 'tree';
  location.hash = '#/domain/' + encodeURIComponent(id);
}
window.addEventListener('hashchange', render);

function showToast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(()=>toastEl.classList.remove('show'), 1800);
}

function uid(prefix){ return (prefix||'x') + '_' + Math.random().toString(36).slice(2,10); }

function nextDomainCode(){
  const nums = domains.map(d => parseInt((d.code||'D-000').split('-')[1],10)).filter(n=>!isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return 'D-' + String(max+1).padStart(3,'0');
}
function nextGroupCode(domain){ return 'G-' + ((domain.groups||[]).length + 1); }
function nextItemCode(container){ return 'I-' + ((container.items||[]).length + 1); }

/* ---- Lookup helpers ---- */
function findDomain(did){ return domains.find(d=>d.id===did); }
function findGroup(domain, gid){ return domain && gid ? (domain.groups||[]).find(g=>g.id===gid) : null; }
function locateItem(did, gid, iid){
  const domain = findDomain(did);
  if(!domain) return {};
  if(gid){
    const group = findGroup(domain, gid);
    const item = group && (group.items||[]).find(x=>x.id===iid);
    return {domain, group, item};
  }
  const item = (domain.items||[]).find(x=>x.id===iid);
  return {domain, group:null, item};
}
function allItemsOf(domain){
  let items = (domain.items||[]).map(it=>Object.assign({}, it, {_gid:null}));
  (domain.groups||[]).forEach(g=> items.push(...(g.items||[]).map(it=>Object.assign({}, it, {_gid:g.id}))));
  return items;
}

/* ---- Recurrence & due-date engine ---- */
const DAY_MS = 86400000;
function startOfDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }
function addUnits(date, every, unit){
  const d = new Date(date);
  if(unit==='days') d.setDate(d.getDate()+every);
  else if(unit==='weeks') d.setDate(d.getDate()+every*7);
  else if(unit==='months') d.setMonth(d.getMonth()+every);
  else if(unit==='years') d.setFullYear(d.getFullYear()+every);
  return d;
}
function nextFixedOccurrence(month, day, from){
  const year = from.getFullYear();
  let candidate = startOfDay(new Date(year, (month||1)-1, day||1));
  if(candidate < startOfDay(from)) candidate = startOfDay(new Date(year+1, (month||1)-1, day||1));
  return candidate;
}
function latestLogDate(item){
  const log = item.log||[];
  return log.reduce((max,l)=> (!max || l.date>max) ? l.date : max, null);
}
function latestLogMileage(item){
  const log = item.log||[];
  for(let i=0;i<log.length;i++){ if(log[i].meta && log[i].meta.mileage!=null) return log[i].meta.mileage; }
  return null;
}
function dueInfo(item, today){
  if(item.kind !== 'recurring') return null;
  today = today || startOfDay(new Date());
  const rec = item.recurrence || {type:'once', date:null};
  const lead = item.reminderLeadDays==null ? 14 : Number(item.reminderLeadDays);

  if(rec.type === 'once'){
    if(item.completedAt) return {dueDate:null, state:'done'};
    if(!rec.date) return {dueDate:null, state:'unknown'};
    const due = startOfDay(rec.date);
    const days = Math.round((due-today)/DAY_MS);
    return {dueDate: rec.date, state: days<0 ? 'overdue' : days<=lead ? 'due_soon' : 'upcoming'};
  }
  if(rec.type === 'fixed'){
    const due = nextFixedOccurrence(rec.month, rec.day, today);
    const days = Math.round((due-today)/DAY_MS);
    return {dueDate: due.toISOString().slice(0,10), state: days<0 ? 'overdue' : days<=lead ? 'due_soon' : 'upcoming'};
  }
  /* interval */
  if(rec.unit === 'miles'){
    const current = (item.fields && item.fields.currentMileage!=null && item.fields.currentMileage!=='') ? Number(item.fields.currentMileage) : null;
    if(current==null || isNaN(current)) return {dueDate:null, state:'unknown'};
    const base = latestLogMileage(item) || 0;
    const target = base + Number(rec.every||0);
    const remaining = target - current;
    const soonWindow = Math.max(Number(rec.every||0) * 0.1, 100);
    return {dueDate:null, state: remaining<0 ? 'overdue' : remaining<=soonWindow ? 'due_soon' : 'upcoming', targetMileage: target, remaining};
  }
  const base = latestLogDate(item) || (item.createdAt ? item.createdAt.slice(0,10) : today.toISOString().slice(0,10));
  const due = startOfDay(addUnits(new Date(base), Number(rec.every||1), rec.unit||'months'));
  const days = Math.round((due-today)/DAY_MS);
  return {dueDate: due.toISOString().slice(0,10), state: days<0 ? 'overdue' : days<=lead ? 'due_soon' : 'upcoming'};
}

/* Friendly presets for the recurrence popover; "custom" falls through to raw every+unit inputs. */
const RECUR_PRESETS = [
  {key:'weekly', label:'Weekly', every:1, unit:'weeks'},
  {key:'monthly', label:'Monthly', every:1, unit:'months'},
  {key:'quarterly', label:'Every 3 months', every:3, unit:'months'},
  {key:'biannual', label:'Every 6 months', every:6, unit:'months'},
  {key:'yearly', label:'Yearly', every:1, unit:'years'}
];
const MONTH_LABEL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function describeRecurrence(item){
  const rec = item.recurrence || {type:'interval', every:3, unit:'months'};
  if(rec.type==='once') return rec.date ? `One-off, due ${rec.date}` : 'One-off — no date set';
  if(rec.type==='fixed') return `Every year on ${MONTH_LABEL[(rec.month||1)-1]} ${rec.day||1}`;
  const preset = RECUR_PRESETS.find(p=>p.every===rec.every && p.unit===rec.unit);
  if(preset) return preset.label;
  const label = RECUR_UNIT_LABEL[rec.unit] || rec.unit;
  const unitWord = label.replace('(s)', rec.every===1 ? '' : 's');
  return `Every ${rec.every} ${unitWord}`;
}

/* ---- Health rollups (computed, never stored) ---- */
function itemHealth(item){
  if(item.kind === 'task'){
    if(item.status==='done') return 'done';
    if(item.status==='blocked') return 'attention';
    return 'on_track';
  }
  const info = dueInfo(item);
  if(info.state==='overdue' || info.state==='due_soon') return 'attention';
  if(info.state==='done') return 'done';
  return 'on_track';
}
function groupHealth(group){
  const items = group.items||[];
  if(!items.length) return 'on_track';
  const hs = items.map(itemHealth);
  if(hs.includes('attention')) return 'attention';
  if(hs.every(h=>h==='done')) return 'done';
  return 'on_track';
}
function domainHealth(domain){
  const items = allItemsOf(domain);
  if(!items.length) return 'on_track';
  const hs = items.map(itemHealth);
  if(hs.includes('attention')) return 'attention';
  if(hs.every(h=>h==='done')) return 'done';
  return 'on_track';
}
function domainCounts(domain){
  const counts = {attention:0, on_track:0, done:0};
  allItemsOf(domain).forEach(it=> counts[itemHealth(it)]++);
  return counts;
}
function domainSummaryText(domain){
  const groups = (domain.groups||[]).length;
  const items = allItemsOf(domain).length;
  if(!items && !groups) return 'empty — add items to get started';
  const c = domainCounts(domain);
  const parts = [];
  if(groups) parts.push(groups+' group'+(groups!==1?'s':''));
  parts.push(items+' item'+(items!==1?'s':''));
  if(c.attention) parts.push(c.attention+' need'+(c.attention===1?'s':'')+' attention');
  return parts.join(' · ');
}
function checklistProgress(item){
  const cl = item.checklist||[];
  if(cl.length) return Math.round((cl.filter(t=>t.done).length/cl.length)*100);
  return item.status==='done' ? 100 : item.status==='blocked' ? 40 : item.status==='in_progress' ? 50 : 0;
}

function timeAgo(iso){
  if(!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs/60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins/60);
  if(hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs/24);
  if(days < 30) return days + 'd ago';
  const months = Math.floor(days/30);
  return months + 'mo ago';
}

/* ---- Storage + migration ---- */
async function loadDomains(){
  try{
    const raw = await Store.get('domains');
    if(raw){ domains = JSON.parse(raw); render(); return; }
  }catch(e){ /* fall through to migration */ }
  try{
    const legacyRaw = await Store.get('projects');
    if(legacyRaw){
      const legacy = JSON.parse(legacyRaw);
      domains = legacy.map(migrateLegacyProject);
      await persist();
      showToast('migrated your existing projects into Anchor');
    } else {
      domains = [];
    }
  }catch(e){ domains = []; }
  render();
}
function migrateLegacyProject(p){
  const groups = (p.epics||[]).map(e => ({
    id: e.id, code: (e.code||'E-0').replace(/^E/,'G'),
    name: e.name, notes: e.description||'', fields:{},
    items: (e.stories||[]).map(legacyStoryToItem)
  }));
  const items = [];
  if((p.tasks||[]).length){
    const allDone = p.tasks.every(t=>t.done);
    const anyDone = p.tasks.some(t=>t.done);
    items.push({
      id: uid('i'), code:'I-0', title:'Quick tasks', notes:'', kind:'task', fields:{},
      status: allDone ? 'done' : anyDone ? 'in_progress' : 'not_started',
      checklist: p.tasks.map(t=>({id:t.id, text:t.text, done:t.done}))
    });
  }
  return {
    id: p.id, code: (p.code||'P-000').replace(/^P/,'D'),
    name: p.name, category:'software', notes: p.description||'', fields:{},
    groups, items,
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || new Date().toISOString()
  };
}
function legacyStoryToItem(s){
  return {
    id: s.id, code: (s.code||'S-0').replace(/^S/,'I'),
    title: s.name, notes: s.description||'', kind:'task', fields:{},
    status: s.status||'not_started',
    checklist: (s.tasks||[]).map(t=>({id:t.id, text:t.text, done:t.done}))
  };
}
async function persist(){
  try{ await Store.set('domains', JSON.stringify(domains)); }
  catch(e){ showToast('save failed — storage blocked'); }
}

/* ---- Theme ---- */
async function loadTheme(){
  let theme = await Store.get('theme');
  if(!theme){
    theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  applyTheme(theme);
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.getElementById('themeColor');
  if(meta) meta.setAttribute('content', theme==='light' ? '#F5F6F8' : '#0F1218');
  document.querySelectorAll('[data-theme-opt]').forEach(btn=>{
    btn.classList.toggle('active', btn.getAttribute('data-theme-opt')===theme);
  });
}
async function setTheme(theme){
  applyTheme(theme);
  try{ await Store.set('theme', theme); }catch(e){}
}
document.querySelectorAll('[data-theme-opt]').forEach(btn=>{
  btn.addEventListener('click', ()=> setTheme(btn.getAttribute('data-theme-opt')));
});

/* ---- Global view toggle ---- */
document.querySelectorAll('[data-global-view]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    globalView = btn.getAttribute('data-global-view');
    document.querySelectorAll('[data-global-view]').forEach(b=>b.classList.toggle('active', b.getAttribute('data-global-view')===globalView));
    render();
  });
});

/* ---- Domain CRUD ---- */
function createDomain(name, category, notes){
  category = CATEGORIES[category] ? category : 'software';
  const d = {
    id: uid('d'), code: nextDomainCode(), name: name && name.trim() ? name.trim() : 'New domain',
    category, notes: notes||'', fields:{}, groups:[], items:[],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  domains.unshift(d);
  globalView = 'list';
  document.querySelectorAll('[data-global-view]').forEach(b=>b.classList.toggle('active', b.getAttribute('data-global-view')==='list'));
  persist();
  openDomainPage(d.id);
}
function updateDomain(id, patch){
  const d = findDomain(id);
  if(!d) return;
  Object.assign(d, patch, {updatedAt: new Date().toISOString()});
  persist(); render();
}
function updateDomainField(id, key, value){
  const d = findDomain(id);
  if(!d) return;
  d.fields = d.fields || {};
  d.fields[key] = value;
  d.updatedAt = new Date().toISOString();
  persist(); render();
}
function deleteDomain(id){
  domains = domains.filter(x=>x.id!==id);
  const route = currentRoute();
  if(route.view==='domain' && route.id===id){ location.hash = ''; }
  persist(); render();
}

/* ---- Group CRUD ---- */
function addGroup(did, name, notes){
  if(!name || !name.trim()) return;
  const d = findDomain(did);
  if(!d) return;
  d.groups = d.groups || [];
  const g = {id: uid('g'), code: nextGroupCode(d), name: name.trim(), notes: notes||'', fields:{}, items:[]};
  d.groups.push(g);
  d.updatedAt = new Date().toISOString();
  persist(); render();
}
function updateGroup(did, gid, patch){
  const d = findDomain(did);
  const g = findGroup(d, gid);
  if(!g) return;
  Object.assign(g, patch);
  d.updatedAt = new Date().toISOString();
  persist(); render();
}
function updateGroupField(did, gid, key, value){
  const d = findDomain(did);
  const g = findGroup(d, gid);
  if(!g) return;
  g.fields = g.fields || {};
  g.fields[key] = value;
  d.updatedAt = new Date().toISOString();
  persist(); render();
}
function deleteGroup(did, gid){
  const d = findDomain(did);
  if(!d) return;
  d.groups = (d.groups||[]).filter(x=>x.id!==gid);
  d.updatedAt = new Date().toISOString();
  persist(); render();
}

/* ---- Item CRUD ---- */
function addItem(did, gid, kind, title, status, notes){
  if(!title || !title.trim()) return;
  const d = findDomain(did);
  if(!d) return;
  const container = gid ? findGroup(d, gid) : d;
  if(!container) return;
  container.items = container.items || [];
  const item = {
    id: uid('i'), code: nextItemCode(container), title: title.trim(), notes: notes||'',
    kind: kind==='recurring' ? 'recurring' : 'task', fields:{}
  };
  if(item.kind==='task'){
    item.status = status||'not_started';
    item.checklist = [];
    item.dueDate = null;
  } else {
    item.recurrence = {type:'interval', every:3, unit:'months'};
    item.reminderLeadDays = 14;
    item.completedAt = null;
    item.log = [];
  }
  container.items.push(item);
  d.updatedAt = new Date().toISOString();
  expandedItems.add(item.id);
  persist(); render();
}
function updateItem(did, gid, iid, patch){
  const {domain, item} = locateItem(did, gid, iid);
  if(!item) return;
  Object.assign(item, patch);
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}
function updateItemField(did, gid, iid, key, value){
  const {domain, item} = locateItem(did, gid, iid);
  if(!item) return;
  item.fields = item.fields || {};
  item.fields[key] = value;
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}
function deleteItem(did, gid, iid){
  const d = findDomain(did);
  if(!d) return;
  const container = gid ? findGroup(d, gid) : d;
  if(!container) return;
  container.items = (container.items||[]).filter(x=>x.id!==iid);
  expandedItems.delete(iid);
  d.updatedAt = new Date().toISOString();
  persist(); render();
}
function setItemRecurrenceType(did, gid, iid, type){
  const {domain, item} = locateItem(did, gid, iid);
  if(!item) return;
  const rec = item.recurrence || {};
  if(type==='interval') item.recurrence = rec.type==='interval' ? rec : {type:'interval', every:1, unit:'days'};
  else if(type==='fixed') item.recurrence = rec.type==='fixed' ? rec : {type:'fixed', month:1, day:1};
  else item.recurrence = rec.type==='once' ? rec : {type:'once', date: new Date().toISOString().slice(0,10)};
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}
function setItemRecurrencePreset(did, gid, iid, every, unit){
  const {domain, item} = locateItem(did, gid, iid);
  if(!item) return;
  item.recurrence = {type:'interval', every, unit};
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}
function updateItemRecurrence(did, gid, iid, patch){
  const {domain, item} = locateItem(did, gid, iid);
  if(!item || !item.recurrence) return;
  Object.assign(item.recurrence, patch);
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}

/* ---- Checklist (kind:'task') ---- */
function addChecklistItem(did, gid, iid, text){
  if(!text.trim()) return;
  const {domain, item} = locateItem(did, gid, iid);
  if(!item) return;
  item.checklist = item.checklist || [];
  item.checklist.push({id: uid('c'), text: text.trim(), done:false});
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}
function toggleChecklistItem(did, gid, iid, cid){
  const {domain, item} = locateItem(did, gid, iid);
  const c = item && (item.checklist||[]).find(x=>x.id===cid);
  if(!c) return;
  c.done = !c.done;
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}
function removeChecklistItem(did, gid, iid, cid){
  const {domain, item} = locateItem(did, gid, iid);
  if(!item) return;
  item.checklist = (item.checklist||[]).filter(x=>x.id!==cid);
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}

/* ---- Log (kind:'recurring') ---- */
function addLogEntry(did, gid, iid, entry){
  const {domain, item} = locateItem(did, gid, iid);
  if(!item) return;
  item.log = item.log || [];
  item.log.push({
    id: uid('l'), date: entry.date || new Date().toISOString().slice(0,10),
    note: entry.note||'', cost: entry.cost||'',
    meta: entry.mileage ? {mileage: Number(entry.mileage)} : {}
  });
  item.log.sort((a,b)=> a.date < b.date ? 1 : -1);
  if(item.recurrence && item.recurrence.type==='once') item.completedAt = new Date().toISOString();
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}
function removeLogEntry(did, gid, iid, lid){
  const {domain, item} = locateItem(did, gid, iid);
  if(!item) return;
  item.log = (item.log||[]).filter(l=>l.id!==lid);
  if(item.recurrence && item.recurrence.type==='once' && item.log.length===0) item.completedAt = null;
  domain.updatedAt = new Date().toISOString();
  persist(); render();
}

/* ---- Modal (add group / item with details) ---- */
let modalState = null;
function openModal({type, did, gid, name}){
  modalState = {type, did: did||null, gid: gid||null, name: name||'', status:'not_started', kind:'task', category:'software', notes:''};
  renderModal();
}
function closeModal(){ modalState = null; renderModal(); }
function statusOptions(current){
  return STATUS_ORDER.map(s=>`<option value="${s}" ${current===s?'selected':''}>${STATUS_LABEL[s]}</option>`).join('');
}
function renderModal(){
  const root = document.getElementById('modalRoot');
  if(!modalState){ root.innerHTML=''; return; }
  const domain = modalState.did ? findDomain(modalState.did) : null;
  const cat = domain ? catOf(domain) : CATEGORIES.software;
  let title, subLabel, body;

  if(modalState.type === 'domain'){
    title = 'New domain';
    subLabel = 'top-level';
    body = `
      <div class="field"><span class="field-label">Name</span><input type="text" id="modalName" value="${escapeAttr(modalState.name)}" placeholder="Domain name"></div>
      <div class="field"><span class="field-label">Category</span>
        <div class="cat-chip-grid">${CATEGORY_ORDER.map(k=>{
          const c = CATEGORIES[k];
          return `<button type="button" class="chip ${modalState.category===k?'active':''}" data-modal-category="${k}"><span class="chip-dot ${c.color}"></span>${c.label}</button>`;
        }).join('')}</div>
      </div>
      <div class="field"><span class="field-label">Notes</span><textarea id="modalDesc" placeholder="Optional details...">${escapeHtml(modalState.notes)}</textarea></div>
    `;
  } else if(modalState.type === 'group'){
    title = 'New ' + cat.groupNoun.toLowerCase();
    subLabel = domain ? `${domain.code} — ${escapeHtml(domain.name)}` : '';
    body = `
      <div class="field"><span class="field-label">Name</span><input type="text" id="modalName" value="${escapeAttr(modalState.name)}" placeholder="${cat.groupNoun} name"></div>
      <div class="field"><span class="field-label">Notes</span><textarea id="modalDesc" placeholder="Optional details...">${escapeHtml(modalState.notes)}</textarea></div>
    `;
  } else {
    const group = domain && modalState.gid ? findGroup(domain, modalState.gid) : null;
    title = 'New ' + cat.itemNoun.toLowerCase();
    subLabel = domain ? `${domain.code} — ${escapeHtml(domain.name)}` + (group ? ` / ${group.code} — ${escapeHtml(group.name)}` : ' / ungrouped') : '';
    body = `
      <div class="field"><span class="field-label">Name</span><input type="text" id="modalName" value="${escapeAttr(modalState.name)}" placeholder="${cat.itemNoun} name"></div>
      <div class="field">
        <span class="field-label">Type</span>
        <div class="seg-toggle mini" id="modalKindToggle">
          <button type="button" class="seg-opt ${modalState.kind==='task'?'active':''}" data-modal-kind="task">one-off task</button>
          <button type="button" class="seg-opt ${modalState.kind==='recurring'?'active':''}" data-modal-kind="recurring">recurring</button>
        </div>
      </div>
      ${modalState.kind==='task'
        ? `<div class="field"><span class="field-label">Status</span><select id="modalStatus">${statusOptions(modalState.status)}</select></div>`
        : `<div class="empty-hint">Recurrence, due dates and completion history are set from the item's detail view after it's created.</div>`}
      <div class="field"><span class="field-label">Notes</span><textarea id="modalDesc" placeholder="Optional details...">${escapeHtml(modalState.notes)}</textarea></div>
    `;
  }

  root.innerHTML = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal">
        <div class="modal-title">${title}</div>
        <div class="modal-sub">${subLabel}</div>
        ${body}
        <div class="modal-actions">
          <button class="modal-cancel" id="modalCancel">Cancel</button>
          <button class="modal-save" id="modalSave">Create</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('modalOverlay').addEventListener('click', e=>{ if(e.target.id==='modalOverlay') closeModal(); });
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalSave').addEventListener('click', submitModal);
  document.querySelectorAll('[data-modal-kind]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ modalState.kind = btn.getAttribute('data-modal-kind'); modalState.name = document.getElementById('modalName').value; modalState.notes = document.getElementById('modalDesc').value; renderModal(); });
  });
  document.querySelectorAll('[data-modal-category]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ modalState.category = btn.getAttribute('data-modal-category'); modalState.name = document.getElementById('modalName').value; modalState.notes = document.getElementById('modalDesc').value; renderModal(); });
  });
  const nameEl = document.getElementById('modalName');
  nameEl.focus(); nameEl.select();
  nameEl.addEventListener('keydown', e=>{
    if(e.key==='Enter'){ submitModal(); }
    if(e.key==='Escape'){ closeModal(); }
  });
}
function submitModal(){
  const name = document.getElementById('modalName').value.trim();
  const notes = document.getElementById('modalDesc').value;
  if(!name){ showToast('name is required'); return; }
  if(modalState.type==='domain'){
    createDomain(name, modalState.category, notes);
    showToast('domain added');
  } else if(modalState.type==='group'){
    if(!modalState.did){ showToast('pick a domain first'); return; }
    addGroup(modalState.did, name, notes);
    showToast(catOf(findDomain(modalState.did)).groupNoun.toLowerCase() + ' added');
  } else {
    if(!modalState.did){ showToast('pick a domain first'); return; }
    const status = modalState.kind==='task' ? document.getElementById('modalStatus').value : undefined;
    addItem(modalState.did, modalState.gid, modalState.kind, name, status, notes);
    showToast('item added');
  }
  closeModal();
}

/* ---- Quick add bar ---- */
let qaKind = 'task';
let qaDomainId = null;
let qaGroupId = null;
function populateQuickAdd(){
  const domSel = document.getElementById('qaDomain');
  const grpSel = document.getElementById('qaGroup');
  const addBtn = document.getElementById('qaAdd');
  if(!domSel) return;
  if(domains.length){
    domSel.innerHTML = domains.map(d=>`<option value="${d.id}">${d.code} — ${escapeHtml(d.name)}</option>`).join('');
    qaDomainId = domains.find(d=>d.id===qaDomainId) ? qaDomainId : domains[0].id;
    domSel.value = qaDomainId;
  } else {
    domSel.innerHTML = '<option value="">No domains yet</option>';
    qaDomainId = null;
  }
  const domain = findDomain(qaDomainId);
  const groups = domain ? (domain.groups||[]) : [];
  const groupNoun = domain ? catOf(domain).groupNoun : 'Group';
  grpSel.innerHTML = '<option value="">— ungrouped —</option>' + groups.map(g=>`<option value="${g.id}">${g.code} — ${escapeHtml(g.name)}</option>`).join('');
  qaGroupId = groups.find(g=>g.id===qaGroupId) ? qaGroupId : '';
  grpSel.value = qaGroupId || '';
  grpSel.title = groupNoun;
  addBtn.disabled = !qaDomainId;
}
function quickAddSubmit(){
  const nameInput = document.getElementById('qaName');
  const name = nameInput.value.trim();
  if(!qaDomainId){ showToast('add a domain first'); return; }
  if(!name){ nameInput.focus(); return; }
  addItem(qaDomainId, qaGroupId || null, qaKind, name);
  showToast('item added');
  nameInput.value='';
  nameInput.focus();
}
document.querySelectorAll('[data-qa-kind]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    qaKind = btn.getAttribute('data-qa-kind');
    document.querySelectorAll('[data-qa-kind]').forEach(b=>b.classList.toggle('active', b===btn));
  });
});
document.getElementById('qaDomain').addEventListener('change', e=>{ qaDomainId = e.target.value; qaGroupId=''; populateQuickAdd(); });
document.getElementById('qaGroup').addEventListener('change', e=>{ qaGroupId = e.target.value; });
document.getElementById('qaName').addEventListener('keydown', e=>{ if(e.key==='Enter'){ quickAddSubmit(); } });
document.getElementById('qaAdd').addEventListener('click', quickAddSubmit);
document.getElementById('qaDetails').addEventListener('click', ()=>{
  const name = document.getElementById('qaName').value;
  openModal({type:'item', did:qaDomainId, gid:qaGroupId||null, name});
  modalState.kind = qaKind;
  renderModal();
});

/* ---- Render helpers ---- */
function renderLedgerStrip(){
  const total = domains.length;
  const counts = {attention:0, on_track:0, done:0};
  domains.forEach(d=> counts[domainHealth(d)]++);
  ledgerStrip.innerHTML = `
    <div class="ledger-cell"><div class="ledger-num">${total}</div><div class="ledger-label">Domains</div></div>
    <div class="ledger-cell n-blocked"><div class="ledger-num">${counts.attention}</div><div class="ledger-label">Attention</div></div>
    <div class="ledger-cell n-progress"><div class="ledger-num">${counts.on_track}</div><div class="ledger-label">On track</div></div>
    <div class="ledger-cell n-done"><div class="ledger-num">${counts.done}</div><div class="ledger-label">Done</div></div>
  `;
}
function renderCatChips(){
  const chips = ['all', ...CATEGORY_ORDER].map(key=>{
    const active = currentCatFilter===key;
    if(key==='all') return `<button class="chip ${active?'active':''}" data-cat-filter="all">all</button>`;
    const c = CATEGORIES[key];
    return `<button class="chip ${active?'active':''}" data-cat-filter="${key}"><span class="chip-dot ${c.color}"></span>${c.label}</button>`;
  }).join('');
  catChips.innerHTML = chips;
  document.querySelectorAll('[data-cat-filter]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ currentCatFilter = btn.getAttribute('data-cat-filter'); render(); });
  });
}
function healthBadge(health){ return `<span class="badge ${health}">${HEALTH_LABEL[health]}</span>`; }
function healthNodeBadge(health){ return `<span class="node-badge ${health}">${HEALTH_LABEL[health]}</span>`; }
function dueBadge(item){
  const info = dueInfo(item);
  if(!info) return '';
  let extra = '';
  if(info.dueDate) extra = ' · ' + info.dueDate;
  else if(info.remaining!=null) extra = info.remaining<0 ? ` · ${Math.abs(Math.round(info.remaining))} mi over` : ` · ${Math.round(info.remaining)} mi left`;
  return `<span class="due-chip ${info.state}">${DUE_LABEL[info.state]}${extra}</span>`;
}
function matchesFilter(d){
  if(currentHealthFilter!=='all' && domainHealth(d)!==currentHealthFilter) return false;
  if(currentCatFilter!=='all' && d.category!==currentCatFilter) return false;
  if(searchTerm){
    const hay = (d.name+' '+d.category+' '+(d.notes||'')+' '+JSON.stringify(d.fields||{})).toLowerCase();
    if(!hay.includes(searchTerm.toLowerCase())) return false;
  }
  return true;
}
function escapeHtml(str){
  return (str||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function escapeAttr(str){ return escapeHtml(str); }

/* ---- Click-to-edit field ----
   Renders plain display text by default; swaps to the caller's live editHtml when
   `fieldKey` matches the single app-wide `editingField`. Click on the display starts
   editing; blur/Escape (wired in attachHandlers) ends it. */
function renderField(fieldKey, label, displayHtml, editHtml){
  if(editingField === fieldKey){
    return `<div class="field"><span class="field-label">${label}</span>${editHtml}</div>`;
  }
  return `<div class="field-display" data-start-edit="${escapeAttr(fieldKey)}">
    <span class="field-label">${label}</span>
    <div class="field-display-value">${displayHtml}</div>
  </div>`;
}
function textFieldHtml(value, placeholder){
  return value && String(value).trim()
    ? `<span class="field-text">${escapeHtml(value)}</span>`
    : `<span class="field-text field-empty">${escapeHtml(placeholder||'Click to add')}</span>`;
}

/* ---- Category-specific extra fields ----
   Collapsed to one summary line by default; clicking it expands into normal editable
   fields (one click gets you to something typeable — no second click per field). */
function extraFieldsSummary(configFields, values){
  values = values || {};
  const parts = configFields.map(f=> values[f.key]!=null && values[f.key]!=='' ? String(values[f.key]) : null).filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Click to add ' + configFields.map(f=>f.label.toLowerCase()).join(', ');
}
function renderExtraFields(configFields, values, dataAttr, pathKey){
  if(!configFields || !configFields.length) return '';
  values = values || {};
  const expandKey = dataAttr + '|' + pathKey;
  if(!extraFieldsExpanded.has(expandKey)){
    return `<div class="extra-fields-summary" data-expand-fields="${escapeAttr(expandKey)}">${escapeHtml(extraFieldsSummary(configFields, values))}</div>`;
  }
  const fieldsHtml = configFields.map(f=>{
    const raw = values[f.key]!=null ? String(values[f.key]) : '';
    return `<div class="field"><span class="field-label">${escapeHtml(f.label)}</span>
      <input type="${f.type==='number'?'number':'text'}" value="${escapeAttr(raw)}" data-${dataAttr}="${pathKey}|${f.key}">
    </div>`;
  }).join('');
  return `<div class="extra-fields">${fieldsHtml}<button class="collapse-fields-btn" data-collapse-fields="${escapeAttr(expandKey)}">hide details</button></div>`;
}

/* ---- Main render ---- */
function render(){
  const route = currentRoute();
  renderLedgerStrip();
  renderCatChips();
  populateQuickAdd();
  document.querySelectorAll('[data-top-view]').forEach(b=>{
    b.classList.toggle('on', b.getAttribute('data-top-view') === (route.view==='tasks' ? 'tasks' : 'domains'));
  });
  if(domainsWidgetsEl) domainsWidgetsEl.style.display = route.view==='domains' ? '' : 'none';
  healthTabsEl.classList.toggle('disabled', route.view!=='domains' || globalView==='board');

  if(route.view==='tasks'){
    /* Both the domain page and tasks board are single-column flowing pages, not the
       2-column card grid — reuse .board-mode's display:block for that, same as the
       domains board sub-view. */
    grid.classList.add('board-mode');
    grid.innerHTML = renderTasksBoard();
  } else if(route.view==='domain'){
    const d = findDomain(route.id);
    grid.classList.add('board-mode');
    grid.innerHTML = d ? renderDomainPage(d) : `<div class="empty-state">
      <div class="em-title">Domain not found</div>
      <div>It may have been deleted. <button class="back-link" data-open-domains-list style="display:inline;">&larr; All domains</button></div>
    </div>`;
  } else if(globalView==='board'){
    grid.classList.add('board-mode');
    grid.innerHTML = renderGlobalBoard();
  } else {
    grid.classList.remove('board-mode');
    const visible = domains.filter(matchesFilter);
    if(visible.length===0){
      grid.innerHTML = `<div class="empty-state">
        <div class="em-title">${domains.length===0 ? 'No domains yet' : 'Nothing matches that filter'}</div>
        <div>${domains.length===0 ? 'Add your first domain — a project, or a life area like Car or Home — to start tracking it.' : 'Try a different filter or search term.'}</div>
      </div>`;
      attachHandlers();
      return;
    }
    grid.innerHTML = visible.map(renderDomainCard).join('');
  }
  attachHandlers();
}
function renderDomainCard(d){
  const health = domainHealth(d);
  const cat = catOf(d);
  const counts = domainCounts(d);
  const groups = (d.groups||[]).length;
  const items = allItemsOf(d).length;
  return `
    <div class="card" data-open-domain-page="${d.id}">
      <div class="status-stripe ${health}"></div>
      <div class="card-body">
        <div class="card-top">
          <div class="card-titles">
            <div class="card-code">${d.code}</div>
            <div class="card-name">${escapeHtml(d.name)}</div>
            <div class="card-cat"><span class="chip-dot ${cat.color}"></span>${cat.label}</div>
          </div>
          ${healthBadge(health)}
        </div>
        ${d.notes ? `<div class="card-desc">${escapeHtml(d.notes)}</div>` : ''}
        <div class="dcard-counts">
          <div class="dcount attention"><span class="dcount-num">${counts.attention}</span><span class="dcount-label">Attn</span></div>
          <div class="dcount on_track"><span class="dcount-num">${counts.on_track}</span><span class="dcount-label">Track</span></div>
          <div class="dcount done"><span class="dcount-num">${counts.done}</span><span class="dcount-label">Done</span></div>
        </div>
        <div class="card-meta">
          <div class="task-count">${groups} group${groups!==1?'s':''} &middot; ${items} item${items!==1?'s':''}</div>
          <div class="updated">${timeAgo(d.updatedAt)}</div>
        </div>
      </div>
    </div>
  `;
}

const HEALTH_ORDER = ['attention','on_track','done'];
function renderGlobalBoard(){
  const term = searchTerm.toLowerCase();
  const filtered = domains.filter(d=> (currentCatFilter==='all'||d.category===currentCatFilter) && (!term || (d.name+' '+d.category+' '+(d.notes||'')).toLowerCase().includes(term)));
  let html = '<div class="board">';
  HEALTH_ORDER.forEach(health=>{
    const items = filtered.filter(d=>domainHealth(d)===health);
    html += `<div class="board-col">
      <div class="board-col-head"><span class="board-col-dot ${health}"></span>${HEALTH_LABEL[health]}<span class="board-col-count">${items.length}</span></div>
      <div class="board-col-body">
        ${items.length ? items.map(d=>renderBoardDomainCard(d)).join('') : '<div class="empty-hint">nothing here</div>'}
      </div>
    </div>`;
  });
  html += '</div>';
  return html;
}
function renderBoardDomainCard(d){
  const cat = catOf(d);
  return `<div class="board-card" data-open-domain-page="${d.id}">
    <div class="board-card-code">${d.code}</div>
    <div class="board-card-name">${escapeHtml(d.name)}</div>
    <div class="board-card-sub"><span class="chip-dot ${cat.color}"></span>${cat.label} · ${domainSummaryText(d)}</div>
  </div>`;
}

function renderCategoryChipGrid(fieldKey, selected, dataAttr, pathKey){
  return `<div class="cat-chip-grid" data-field-input="${escapeAttr(fieldKey)}">${CATEGORY_ORDER.map(k=>{
    const c = CATEGORIES[k];
    return `<button type="button" class="chip ${selected===k?'active':''}" data-${dataAttr}="${pathKey!=null?pathKey+'|':''}${k}"><span class="chip-dot ${c.color}"></span>${c.label}</button>`;
  }).join('')}</div>`;
}
function renderDomainPage(d){
  const cat = catOf(d);
  const health = domainHealth(d);
  const nameFieldKey = 'dn|'+d.id, notesFieldKey = 'dno|'+d.id, catFieldKey = 'dc|'+d.id;
  const groups = d.groups||[];

  const healthFilters = [['all','All'],['attention','Attention'],['on_track','On track'],['done','Done']];
  const itemPasses = it => domainPageHealthFilter==='all' || itemHealth(it)===domainPageHealthFilter;
  const showUngrouped = domainPageGroupFilter==='all';
  const visibleGroups = groups.filter(g=> domainPageGroupFilter==='all' || domainPageGroupFilter===g.id);
  const ungroupedItems = showUngrouped ? (d.items||[]).filter(itemPasses) : [];

  let bodyHtml;
  if(groupViewMode==='board'){
    bodyHtml = renderItemsBoard(d);
  } else {
    const sections = [];
    if(ungroupedItems.length || (showUngrouped && groups.length===0)){
      sections.push(renderItemsCardSection(d, ungroupedItems));
    }
    visibleGroups.forEach(g=>{
      sections.push(renderGroupSection(d, g, (g.items||[]).filter(itemPasses)));
    });
    bodyHtml = sections.length ? sections.join('') : `<div class="empty-hint">Nothing matches this filter.</div>`;
  }

  return `
    <button class="back-link" data-open-domains-list>&larr; All domains</button>
    <div class="dhead">
      <div class="dhead-top">
        <div class="card-titles">
          <div class="dhead-code">${d.code}</div>
          <div class="dhead-name">${renderField(nameFieldKey, 'Name',
            textFieldHtml(d.name),
            `<input type="text" value="${escapeAttr(d.name)}" data-edit-domain-name="${d.id}" data-field-input="${nameFieldKey}">`
          )}</div>
        </div>
        ${healthBadge(health)}
      </div>
      ${renderField(catFieldKey, 'Category',
        `<span class="field-text"><span class="chip-dot ${cat.color}"></span>${cat.label}</span>`,
        renderCategoryChipGrid(catFieldKey, d.category, 'set-domain-category', d.id)
      )}
      ${renderField(notesFieldKey, 'Notes',
        textFieldHtml(d.notes, 'What is this domain, and where does it stand?'),
        `<textarea data-edit-domain-notes="${d.id}" data-field-input="${notesFieldKey}" placeholder="What is this domain, and where does it stand?">${escapeHtml(d.notes||'')}</textarea>`
      )}
      ${renderExtraFields(cat.domainFields, d.fields, 'edit-domain-field', d.id)}
    </div>

    <div class="dfilters">
      <div class="dfilter-group">
        <span class="dfilter-label">Status</span>
        <div class="dfilter-chips">${healthFilters.map(([k,l])=>`<button class="chip ${domainPageHealthFilter===k?'active':''}" data-domain-health-filter="${k}">${l}</button>`).join('')}</div>
      </div>
      ${groups.length ? `<div class="dfilter-group">
        <span class="dfilter-label">${cat.groupNoun}</span>
        <div class="dfilter-chips">
          <button class="chip ${domainPageGroupFilter==='all'?'active':''}" data-domain-group-filter="all">All</button>
          ${groups.map(g=>`<button class="chip ${domainPageGroupFilter===g.id?'active':''}" data-domain-group-filter="${g.id}">${escapeHtml(g.name)}</button>`).join('')}
        </div>
      </div>` : ''}
      <div class="dfilter-group">
        <span class="dfilter-label">View</span>
        <div class="seg-toggle mini">
          <button class="seg-opt ${groupViewMode==='tree'?'active':''}" data-group-view="tree">cards</button>
          <button class="seg-opt ${groupViewMode==='board'?'active':''}" data-group-view="board">board</button>
        </div>
      </div>
    </div>

    <div class="dactions">
      <button class="ghost-btn" data-open-item-modal="${d.id}|">+ Add ${cat.itemNoun.toLowerCase()}</button>
      <button class="ghost-btn" data-open-group-modal="${d.id}">+ Add ${cat.groupNoun.toLowerCase()}</button>
    </div>

    ${bodyHtml}

    <div class="detail-footer">
      <button class="delete-btn" data-delete-domain="${d.id}">delete domain</button>
    </div>
  `;
}
function renderIcard(d, g, it){
  const gid = g ? g.id : '';
  const isOpen = expandedItems.has(it.id);
  if(isOpen){
    return `<div class="icard icard-open" style="grid-column:1/-1;">
      <div class="icard-top" data-toggle-item="${d.id}|${gid}|${it.id}">
        <div><div class="icard-code">${it.code}</div><div class="icard-name">${escapeHtml(it.title)}</div></div>
        <span class="node-caret open">&rsaquo;</span>
      </div>
      ${renderItemDetail(d,g,it)}
    </div>`;
  }
  const rightBit = it.kind==='task' ? `<span class="badge ${it.status}">${STATUS_LABEL[it.status]}</span>` : dueBadge(it);
  const sub = it.kind==='task' ? `${checklistProgress(it)}% checklist complete` : describeRecurrence(it);
  return `<div class="icard" data-toggle-item="${d.id}|${gid}|${it.id}">
    <div class="icard-top">
      <div><div class="icard-code">${it.code}</div><div class="icard-name">${escapeHtml(it.title)}</div></div>
      ${rightBit}
    </div>
    <div class="icard-sub">${sub}</div>
  </div>`;
}
function renderItemsCardSection(d, items){
  const cat = catOf(d);
  return `<div class="group-section">
    <div class="icards">
      ${items.map(it=>renderIcard(d,null,it)).join('')}
      <button class="add-icard" data-open-item-modal="${d.id}|">+ Add ${cat.itemNoun.toLowerCase()}</button>
    </div>
  </div>`;
}
function renderGroupSection(d, g, items){
  const cat = catOf(d);
  return `<div class="group-section">
    <div class="group-head">
      ${renderField('gn|'+d.id+'|'+g.id, 'Name', textFieldHtml(g.name), `<input type="text" value="${escapeAttr(g.name)}" data-edit-group-name="${d.id}|${g.id}" data-field-input="gn|${d.id}|${g.id}">`)}
    </div>
    ${renderField('gno|'+d.id+'|'+g.id, 'Notes', textFieldHtml(g.notes, `What does this ${cat.groupNoun.toLowerCase()} cover?`), `<textarea data-edit-group-notes="${d.id}|${g.id}" data-field-input="gno|${d.id}|${g.id}" placeholder="What does this ${cat.groupNoun.toLowerCase()} cover?">${escapeHtml(g.notes||'')}</textarea>`)}
    ${renderExtraFields(cat.groupFields, g.fields, 'edit-group-field', d.id+'|'+g.id)}
    <div class="group-meta-row">
      <span class="group-meta">${(g.items||[]).length} ${cat.itemNoun.toLowerCase()}${(g.items||[]).length!==1?'s':''}</span>
      <button class="group-add-btn" data-open-item-modal="${d.id}|${g.id}">+ add ${cat.itemNoun.toLowerCase()}</button>
      <button class="delete-btn" data-delete-group="${d.id}|${g.id}">delete ${cat.groupNoun.toLowerCase()}</button>
    </div>
    <div class="icards">
      ${items.map(it=>renderIcard(d,g,it)).join('')}
      <button class="add-icard" data-open-item-modal="${d.id}|${g.id}">+ Add ${cat.itemNoun.toLowerCase()}</button>
    </div>
  </div>`;
}

function renderItemsBoard(d){
  const items = allItemsOf(d);
  let html = '<div class="board story-board">';
  HEALTH_ORDER.forEach(health=>{
    const inCol = items.filter(it=>itemHealth(it)===health);
    html += `<div class="board-col">
      <div class="board-col-head"><span class="board-col-dot ${health}"></span>${HEALTH_LABEL[health]}<span class="board-col-count">${inCol.length}</span></div>
      <div class="board-col-body" data-drop-zone-item="${d.id}|${health}">
        ${inCol.length ? inCol.map(it=>renderBoardItemCard(d,it)).join('') : '<div class="empty-hint">nothing here</div>'}
      </div>
    </div>`;
  });
  html += '</div>';
  if(items.length===0) html += '<div class="empty-hint">Switch to tree view to add items first.</div>';
  return html;
}
function renderBoardItemCard(d, it){
  const sub = it.kind==='task' ? checklistProgress(it)+'%' : dueBadge(it);
  const draggable = it.kind==='task';
  return `<div class="board-card" data-open-item="${d.id}|${it._gid||''}|${it.id}" ${draggable?`draggable="true" data-drag-item="${d.id}|${it._gid||''}|${it.id}"`:''}>
    <div class="board-card-code">${it.code}</div>
    <div class="board-card-name">${escapeHtml(it.title)}</div>
    <div class="board-card-sub">${sub}</div>
  </div>`;
}

/* ---- Global tasks board (kind:'task' items across every domain) ---- */
function allTaskItemsFlat(){
  const out = [];
  domains.forEach(d=>{
    (d.items||[]).forEach(it=>{ if(it.kind==='task') out.push({d, g:null, it}); });
    (d.groups||[]).forEach(g=>{
      (g.items||[]).forEach(it=>{ if(it.kind==='task') out.push({d, g, it}); });
    });
  });
  return out;
}
function matchesTaskDateFilter(it){
  if(tasksDatePreset==='all') return true;
  if(!it.dueDate) return false;
  const due = startOfDay(it.dueDate);
  const today = startOfDay(new Date());
  if(tasksDatePreset==='today') return due.getTime()===today.getTime();
  if(tasksDatePreset==='tomorrow') return due.getTime()===startOfDay(addUnits(today,1,'days')).getTime();
  if(tasksDatePreset==='week'){ const end = startOfDay(addUnits(today,6,'days')); return due>=today && due<=end; }
  if(tasksDatePreset==='month') return due.getFullYear()===today.getFullYear() && due.getMonth()===today.getMonth();
  if(tasksDatePreset==='custom'){
    if(tasksCustomFrom && due < startOfDay(tasksCustomFrom)) return false;
    if(tasksCustomTo && due > startOfDay(tasksCustomTo)) return false;
    return true;
  }
  return true;
}
function taskDueMeta(it){
  if(!it.dueDate) return {label:'No due date', chipClass:'unknown'};
  const due = startOfDay(it.dueDate);
  const today = startOfDay(new Date());
  const days = Math.round((due-today)/DAY_MS);
  const label = days===0 ? 'Today' : days===1 ? 'Tomorrow' : due.toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const chipClass = days<0 ? 'overdue' : days<=1 ? 'due_soon' : 'upcoming';
  return {label, chipClass};
}
function renderTaskCard(d, g, it){
  const due = taskDueMeta(it);
  const context = g ? `${escapeHtml(d.name)} &middot; ${escapeHtml(g.name)}` : escapeHtml(d.name);
  return `<div class="board-card" draggable="true" data-drag-task="${d.id}|${g?g.id:''}|${it.id}">
    <div class="board-card-name">${escapeHtml(it.title)}</div>
    <div class="board-card-sub">${context}</div>
    <div class="board-card-sub"><span class="due-chip ${due.chipClass}">${due.label}</span></div>
  </div>`;
}
const DATE_PRESET_LABEL = [['all','All'],['today','Today'],['tomorrow','Tomorrow'],['week','This week'],['month','This month'],['custom','Custom range&hellip;']];
function renderTasksBoard(){
  const matches = allTaskItemsFlat().filter(x=> (tasksCatFilter==='all'||x.d.category===tasksCatFilter) && matchesTaskDateFilter(x.it));
  const domainCount = new Set(domains.map(d=>d.id)).size;
  let html = `
    <div class="tb-head">
      <div><h2 class="tb-title">Tasks</h2><div class="tb-sub">${matches.length} task${matches.length!==1?'s':''} ${tasksDatePreset==='all'&&tasksCatFilter==='all'?`across ${domainCount} domain${domainCount!==1?'s':''}`:'matching your filters'}</div></div>
    </div>
    <div class="chip-row">
      ${DATE_PRESET_LABEL.map(([k,l])=>`<button class="chip ${tasksDatePreset===k?'active':''}" data-task-date-preset="${k}">${l}</button>`).join('')}
    </div>
    <div class="date-range ${tasksDatePreset==='custom'?'open':''}">
      <span>From</span><input type="date" value="${tasksCustomFrom||''}" data-task-range-from>
      <span>To</span><input type="date" value="${tasksCustomTo||''}" data-task-range-to>
    </div>
    <div class="chip-row">
      <button class="chip ${tasksCatFilter==='all'?'active':''}" data-task-cat-filter="all">All domains</button>
      ${CATEGORY_ORDER.map(k=>{ const c=CATEGORIES[k]; return `<button class="chip ${tasksCatFilter===k?'active':''}" data-task-cat-filter="${k}"><span class="chip-dot ${c.color}"></span>${c.label}</button>`; }).join('')}
    </div>
  `;
  if(!matches.length){
    html += `<div class="empty-state">
      <div class="em-title">No tasks match</div>
      <div>Try a different date range or domain filter, or add a one-off task from a domain page.</div>
    </div>`;
    return html;
  }
  html += '<div class="board">';
  STATUS_ORDER.forEach(status=>{
    const inCol = matches.filter(x=>x.it.status===status);
    html += `<div class="board-col">
      <div class="board-col-head"><span class="board-col-dot ${status}"></span>${STATUS_LABEL[status]}<span class="board-col-count">${inCol.length}</span></div>
      <div class="board-col-body" data-drop-zone-task="${status}">
        ${inCol.length ? inCol.map(x=>renderTaskCard(x.d,x.g,x.it)).join('') : '<div class="empty-hint">nothing here</div>'}
      </div>
    </div>`;
  });
  html += '</div>';
  return html;
}

function renderRecurPopover(key, it){
  const rec = it.recurrence || {type:'interval', every:3, unit:'months'};
  const subKey = 'irec-sub|'+key;
  if(editingField === subKey){
    let subFields;
    if(rec.type==='fixed'){
      subFields = `
        <div class="recur-row">
          <div class="field"><span class="field-label">Month</span><input type="number" min="1" max="12" value="${rec.month}" data-edit-recur-month="${key}"></div>
          <div class="field"><span class="field-label">Day</span><input type="number" min="1" max="31" value="${rec.day}" data-edit-recur-day="${key}"></div>
        </div>`;
    } else if(rec.type==='once'){
      subFields = `<div class="recur-row"><div class="field"><span class="field-label">Date</span><input type="date" value="${rec.date||''}" data-edit-recur-date="${key}"></div></div>`;
    } else {
      subFields = `
        <div class="recur-row">
          <div class="field"><span class="field-label">Every</span><input type="number" min="1" value="${rec.every}" data-edit-recur-every="${key}"></div>
          <div class="field"><span class="field-label">Unit</span><select data-edit-recur-unit="${key}">
            ${['days','weeks','months','years','miles'].map(u=>`<option value="${u}" ${rec.unit===u?'selected':''}>${RECUR_UNIT_LABEL[u]}</option>`).join('')}
          </select></div>
        </div>`;
    }
    return `<div class="recur-popover">
      <div class="chip-row-inline">
        <button type="button" class="chip" data-recur-back="${key}">&lsaquo; back</button>
        <button type="button" class="chip" data-close-field="${subKey}">done</button>
      </div>
      ${subFields}
    </div>`;
  }
  return `<div class="recur-popover">
    <div class="chip-row-inline">
      ${RECUR_PRESETS.map(p=>`<button type="button" class="chip ${rec.type==='interval'&&rec.every===p.every&&rec.unit===p.unit?'active':''}" data-set-recur-preset="${key}|${p.key}">${p.label}</button>`).join('')}
      <button type="button" class="chip" data-set-recur-custom="${key}">Custom&hellip;</button>
      <button type="button" class="chip ${rec.type==='fixed'?'active':''}" data-set-recur-custom-type="${key}|fixed">Fixed date</button>
      <button type="button" class="chip ${rec.type==='once'?'active':''}" data-set-recur-custom-type="${key}|once">One-off</button>
    </div>
  </div>`;
}
function renderItemDetail(d, g, it){
  const gid = g ? g.id : '';
  const key = `${d.id}|${gid}|${it.id}`;
  const cat = catOf(d);
  const common = `
    ${renderField('it|'+key, 'Name',
      textFieldHtml(it.title),
      `<input type="text" value="${escapeAttr(it.title)}" data-edit-item-title="${key}" data-field-input="it|${key}">`
    )}
    ${renderField('ino|'+key, 'Notes',
      textFieldHtml(it.notes, 'Details...'),
      `<textarea data-edit-item-notes="${key}" data-field-input="ino|${key}" placeholder="Details...">${escapeHtml(it.notes||'')}</textarea>`
    )}
    ${renderExtraFields(cat.itemFields, it.fields, 'edit-item-field', key)}
  `;
  let kindBlock;
  if(it.kind==='task'){
    const checklistHtml = (it.checklist||[]).map(t=>`
      <div class="task-item">
        <div class="task-check ${t.done?'checked':''}" data-toggle-checklist="${key}|${t.id}">
          <svg viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-6" stroke="#0B1512" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="task-text ${t.done?'done':''}">${escapeHtml(t.text)}</div>
        <button class="task-del" data-remove-checklist="${key}|${t.id}">&times;</button>
      </div>
    `).join('');
    kindBlock = `
      ${renderField('ist|'+key, 'Status',
        `<span class="badge ${it.status}">${STATUS_LABEL[it.status]}</span>`,
        `<div class="status-chip-row">${STATUS_ORDER.map(s=>`<button type="button" class="chip status-chip ${s} ${it.status===s?'active':''}" data-set-item-status="${key}|${s}">${STATUS_LABEL[s]}</button>`).join('')}</div>`
      )}
      ${renderField('idue|'+key, 'Due date',
        it.dueDate ? `<span class="field-text">${it.dueDate}</span>` : `<span class="field-text field-empty">No due date</span>`,
        `<input type="date" value="${it.dueDate||''}" data-edit-item-due="${key}" data-field-input="idue|${key}">`
      )}
      <div class="field">
        <span class="field-label">Checklist</span>
        <div class="tasks-list">${checklistHtml}</div>
        <div class="add-task-row"><input type="text" placeholder="Add a checklist item and press enter" data-add-checklist="${key}"></div>
      </div>
    `;
  } else {
    const rec = it.recurrence || {type:'interval', every:3, unit:'months'};
    const logHtml = (it.log||[]).map(l=>`
      <div class="log-item">
        <div class="log-item-body">
          <div class="log-item-date">${l.date}</div>
          ${l.note ? `<div class="log-item-note">${escapeHtml(l.note)}</div>` : ''}
          ${(l.cost || (l.meta&&l.meta.mileage!=null)) ? `<div class="log-item-meta">${l.cost?escapeHtml(l.cost):''}${l.cost && l.meta&&l.meta.mileage!=null?' · ':''}${l.meta&&l.meta.mileage!=null?l.meta.mileage+' mi':''}</div>` : ''}
        </div>
        <button class="task-del" data-remove-log="${key}|${l.id}">&times;</button>
      </div>
    `).join('');
    const detailsOpen = logDetailsOpen.has(it.id);
    const logActionsHtml = detailsOpen ? `
      <div class="add-log-row">
        <input type="date" id="logDate-${it.id}" value="${new Date().toISOString().slice(0,10)}">
        <input type="text" id="logNote-${it.id}" placeholder="Note (optional)">
        <input type="text" id="logCost-${it.id}" placeholder="Cost (optional)">
        ${rec.unit==='miles' ? `<input type="number" id="logMileage-${it.id}" placeholder="Mileage">` : ''}
        <button class="qa-btn" data-add-log="${key}">Log entry</button>
        <button class="add-details-link" data-toggle-log-details="${it.id}">cancel</button>
      </div>
    ` : `
      <div class="log-actions">
        <button class="mark-done-btn" data-mark-done="${key}">Mark done today</button>
        <button class="add-details-link" data-toggle-log-details="${it.id}">+ add details</button>
      </div>
    `;
    kindBlock = `
      <div class="due-summary">${dueBadge(it)}</div>
      ${(editingField==='irec|'+key || editingField==='irec-sub|'+key)
        ? `<div class="field"><span class="field-label">Recurrence</span>${renderRecurPopover(key, it)}</div>`
        : `<div class="field-display" data-start-edit="irec|${key}"><span class="field-label">Recurrence</span><div class="field-display-value"><span class="field-text">${describeRecurrence(it)}</span></div></div>`}
      ${renderField('ilead|'+key, 'Remind me',
        `<span class="field-text">${it.reminderLeadDays==null?14:it.reminderLeadDays} days before due</span>`,
        `<input type="number" min="0" value="${it.reminderLeadDays==null?14:it.reminderLeadDays}" data-edit-lead-days="${key}" data-field-input="ilead|${key}">`
      )}
      <div class="field">
        <span class="field-label">Completion log</span>
        <div class="log-list">${logHtml || '<div class="empty-hint">Nothing logged yet.</div>'}</div>
        ${logActionsHtml}
      </div>
    `;
  }
  return `
    <div class="node-detail">
      ${common}
      ${kindBlock}
      <div class="node-footer"><button class="delete-btn" data-delete-item="${key}">delete ${cat.itemNoun.toLowerCase()}</button></div>
    </div>
  `;
}

function attachHandlers(){
  /* Domain */
  document.querySelectorAll('[data-open-domain-page]').forEach(el=>{
    el.addEventListener('click', ()=>{ openDomainPage(el.getAttribute('data-open-domain-page')); });
  });
  document.querySelectorAll('[data-open-domains-list]').forEach(el=>{
    el.addEventListener('click', ()=>{ location.hash = ''; });
  });
  document.querySelectorAll('[data-top-view]').forEach(el=>{
    el.addEventListener('click', ()=>{ location.hash = el.getAttribute('data-top-view')==='tasks' ? '#/tasks' : ''; });
  });
  document.querySelectorAll('[data-domain-health-filter]').forEach(el=>{
    el.addEventListener('click', ()=>{ domainPageHealthFilter = el.getAttribute('data-domain-health-filter'); render(); });
  });
  document.querySelectorAll('[data-domain-group-filter]').forEach(el=>{
    el.addEventListener('click', ()=>{ domainPageGroupFilter = el.getAttribute('data-domain-group-filter'); render(); });
  });
  document.querySelectorAll('[data-delete-domain]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const id = el.getAttribute('data-delete-domain');
      const d = findDomain(id);
      if(confirm(`Delete "${d?d.name:'this domain'}"? This can't be undone.`)){
        deleteDomain(id); showToast('domain deleted');
      }
    });
  });
  document.querySelectorAll('[data-edit-domain-name]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=> updateDomain(el.getAttribute('data-edit-domain-name'), {name: el.value || 'Untitled domain'}));
  });
  document.querySelectorAll('[data-set-domain-category]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,category] = el.getAttribute('data-set-domain-category').split('|');
      editingField = null;
      updateDomain(did, {category});
    });
  });
  document.querySelectorAll('[data-edit-domain-notes]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=> updateDomain(el.getAttribute('data-edit-domain-notes'), {notes: el.value}));
  });
  document.querySelectorAll('[data-edit-domain-field]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,key]=el.getAttribute('data-edit-domain-field').split('|'); updateDomainField(did,key,el.value); });
  });

  document.querySelectorAll('[data-group-view]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); groupViewMode = el.getAttribute('data-group-view'); render(); });
  });
  document.querySelectorAll('[data-open-group-modal]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); openModal({type:'group', did: el.getAttribute('data-open-group-modal')}); });
  });
  document.querySelectorAll('[data-open-item-modal]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,gid] = el.getAttribute('data-open-item-modal').split('|');
      openModal({type:'item', did, gid: gid||null});
    });
  });

  /* Group */
  document.querySelectorAll('[data-edit-group-name]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid]=el.getAttribute('data-edit-group-name').split('|'); updateGroup(did,gid,{name: el.value||'Untitled group'}); });
  });
  document.querySelectorAll('[data-edit-group-notes]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid]=el.getAttribute('data-edit-group-notes').split('|'); updateGroup(did,gid,{notes: el.value}); });
  });
  document.querySelectorAll('[data-edit-group-field]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,key]=el.getAttribute('data-edit-group-field').split('|'); updateGroupField(did,gid,key,el.value); });
  });
  document.querySelectorAll('[data-delete-group]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,gid] = el.getAttribute('data-delete-group').split('|');
      if(confirm('Delete this group and all its items?')){ deleteGroup(did,gid); showToast('group deleted'); }
    });
  });

  /* Item */
  document.querySelectorAll('[data-toggle-item]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const [,,iid] = el.getAttribute('data-toggle-item').split('|');
      if(expandedItems.has(iid)) expandedItems.delete(iid); else expandedItems.add(iid);
      editingField = null;
      render();
    });
  });
  document.querySelectorAll('[data-open-item]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const [,,iid] = el.getAttribute('data-open-item').split('|');
      groupViewMode = 'tree';
      expandedItems.add(iid);
      render();
    });
  });

  /* Board drag & drop — only task-kind items are draggable; dropping sets status */
  document.querySelectorAll('[data-drag-item]').forEach(el=>{
    el.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', el.getAttribute('data-drag-item'));
    });
  });
  document.querySelectorAll('[data-drop-zone-item]').forEach(zone=>{
    zone.addEventListener('dragover', e=>{ e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()=> zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e=>{
      e.preventDefault(); zone.classList.remove('drag-over');
      const key = e.dataTransfer.getData('text/plain');
      if(!key) return;
      const [did,gid,iid] = key.split('|');
      const [zoneDid, health] = zone.getAttribute('data-drop-zone-item').split('|');
      if(did !== zoneDid) return;
      const {item} = locateItem(did, gid, iid);
      if(!item || item.kind!=='task') return;
      const status = health==='attention' ? 'blocked' : health==='done' ? 'done' : 'in_progress';
      updateItem(did, gid, iid, {status});
      showToast('status updated');
    });
  });

  /* Global tasks board */
  document.querySelectorAll('[data-task-date-preset]').forEach(el=>{
    el.addEventListener('click', ()=>{ tasksDatePreset = el.getAttribute('data-task-date-preset'); render(); });
  });
  document.querySelectorAll('[data-task-range-from]').forEach(el=>{
    el.addEventListener('change', ()=>{ tasksCustomFrom = el.value||null; render(); });
  });
  document.querySelectorAll('[data-task-range-to]').forEach(el=>{
    el.addEventListener('change', ()=>{ tasksCustomTo = el.value||null; render(); });
  });
  document.querySelectorAll('[data-task-cat-filter]').forEach(el=>{
    el.addEventListener('click', ()=>{ tasksCatFilter = el.getAttribute('data-task-cat-filter'); render(); });
  });
  document.querySelectorAll('[data-drag-task]').forEach(el=>{
    el.addEventListener('dragstart', e=>{ e.dataTransfer.setData('text/plain', el.getAttribute('data-drag-task')); });
  });
  document.querySelectorAll('[data-drop-zone-task]').forEach(zone=>{
    zone.addEventListener('dragover', e=>{ e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()=> zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e=>{
      e.preventDefault(); zone.classList.remove('drag-over');
      const key = e.dataTransfer.getData('text/plain');
      if(!key) return;
      const [did,gid,iid] = key.split('|');
      const status = zone.getAttribute('data-drop-zone-task');
      const {item} = locateItem(did, gid||null, iid);
      if(!item || item.kind!=='task') return;
      updateItem(did, gid||null, iid, {status});
      showToast('status updated');
    });
  });

  document.querySelectorAll('[data-edit-item-title]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid]=el.getAttribute('data-edit-item-title').split('|'); updateItem(did,gid,iid,{title: el.value||'Untitled item'}); });
  });
  document.querySelectorAll('[data-edit-item-notes]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid]=el.getAttribute('data-edit-item-notes').split('|'); updateItem(did,gid,iid,{notes: el.value}); });
  });
  document.querySelectorAll('[data-edit-item-field]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid,key]=el.getAttribute('data-edit-item-field').split('|'); updateItemField(did,gid,iid,key,el.value); });
  });
  document.querySelectorAll('[data-edit-item-due]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid]=el.getAttribute('data-edit-item-due').split('|'); updateItem(did,gid,iid,{dueDate: el.value||null}); });
  });
  document.querySelectorAll('[data-set-item-status]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,gid,iid,status] = el.getAttribute('data-set-item-status').split('|');
      editingField = null;
      updateItem(did,gid,iid,{status});
    });
  });
  document.querySelectorAll('[data-delete-item]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,gid,iid] = el.getAttribute('data-delete-item').split('|');
      if(confirm('Delete this item? This can\'t be undone.')){ deleteItem(did,gid,iid); showToast('item deleted'); }
    });
  });
  document.querySelectorAll('[data-add-checklist]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('keydown', e=>{ if(e.key==='Enter'){ const [did,gid,iid]=el.getAttribute('data-add-checklist').split('|'); addChecklistItem(did,gid,iid,el.value); el.value=''; } });
  });
  document.querySelectorAll('[data-toggle-checklist]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); const [did,gid,iid,cid]=el.getAttribute('data-toggle-checklist').split('|'); toggleChecklistItem(did,gid,iid,cid); });
  });
  document.querySelectorAll('[data-remove-checklist]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); const [did,gid,iid,cid]=el.getAttribute('data-remove-checklist').split('|'); removeChecklistItem(did,gid,iid,cid); });
  });

  /* Recurrence popover */
  document.querySelectorAll('[data-set-recur-preset]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,gid,iid,presetKey] = el.getAttribute('data-set-recur-preset').split('|');
      const preset = RECUR_PRESETS.find(p=>p.key===presetKey);
      if(!preset) return;
      editingField = null;
      setItemRecurrencePreset(did,gid,iid,preset.every,preset.unit);
    });
  });
  document.querySelectorAll('[data-set-recur-custom]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,gid,iid] = el.getAttribute('data-set-recur-custom').split('|');
      setItemRecurrenceType(did,gid,iid,'interval');
      editingField = 'irec-sub|'+did+'|'+gid+'|'+iid;
      render();
    });
  });
  document.querySelectorAll('[data-set-recur-custom-type]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,gid,iid,type] = el.getAttribute('data-set-recur-custom-type').split('|');
      setItemRecurrenceType(did,gid,iid,type);
      editingField = 'irec-sub|'+did+'|'+gid+'|'+iid;
      render();
    });
  });
  document.querySelectorAll('[data-recur-back]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const key = el.getAttribute('data-recur-back');
      editingField = 'irec|'+key;
      render();
    });
  });
  document.querySelectorAll('[data-close-field]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); editingField = null; render(); });
  });
  document.querySelectorAll('[data-edit-recur-every]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid]=el.getAttribute('data-edit-recur-every').split('|'); updateItemRecurrence(did,gid,iid,{every: Number(el.value)||1}); });
  });
  document.querySelectorAll('[data-edit-recur-unit]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid]=el.getAttribute('data-edit-recur-unit').split('|'); updateItemRecurrence(did,gid,iid,{unit: el.value}); });
  });
  document.querySelectorAll('[data-edit-recur-month]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid]=el.getAttribute('data-edit-recur-month').split('|'); updateItemRecurrence(did,gid,iid,{month: Number(el.value)||1}); });
  });
  document.querySelectorAll('[data-edit-recur-day]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid]=el.getAttribute('data-edit-recur-day').split('|'); updateItemRecurrence(did,gid,iid,{day: Number(el.value)||1}); });
  });
  document.querySelectorAll('[data-edit-recur-date]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid]=el.getAttribute('data-edit-recur-date').split('|'); updateItemRecurrence(did,gid,iid,{date: el.value}); });
  });
  document.querySelectorAll('[data-edit-lead-days]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [did,gid,iid]=el.getAttribute('data-edit-lead-days').split('|'); updateItem(did,gid,iid,{reminderLeadDays: Number(el.value)||0}); });
  });
  document.querySelectorAll('[data-mark-done]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,gid,iid] = el.getAttribute('data-mark-done').split('|');
      addLogEntry(did,gid,iid, {date: new Date().toISOString().slice(0,10)});
      showToast('marked done');
    });
  });
  document.querySelectorAll('[data-toggle-log-details]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const iid = el.getAttribute('data-toggle-log-details');
      if(logDetailsOpen.has(iid)) logDetailsOpen.delete(iid); else logDetailsOpen.add(iid);
      render();
    });
  });
  document.querySelectorAll('[data-add-log]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [did,gid,iid] = el.getAttribute('data-add-log').split('|');
      const dateEl = document.getElementById('logDate-'+iid);
      const noteEl = document.getElementById('logNote-'+iid);
      const costEl = document.getElementById('logCost-'+iid);
      const mileageEl = document.getElementById('logMileage-'+iid);
      const entry = {
        date: dateEl ? dateEl.value : '',
        note: noteEl ? noteEl.value : '',
        cost: costEl ? costEl.value : '',
        mileage: mileageEl ? mileageEl.value : ''
      };
      logDetailsOpen.delete(iid);
      addLogEntry(did,gid,iid, entry);
      showToast('logged');
    });
  });
  document.querySelectorAll('[data-remove-log]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); const [did,gid,iid,lid]=el.getAttribute('data-remove-log').split('|'); removeLogEntry(did,gid,iid,lid); });
  });

  document.querySelectorAll('.detail, .node-detail').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
  });

  /* Click-to-edit: click display text to start editing; blur/Escape ends it */
  document.querySelectorAll('[data-start-edit]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      editingField = el.getAttribute('data-start-edit');
      render();
    });
  });
  document.querySelectorAll('[data-field-input]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('blur', ()=>{
      if(editingField === el.getAttribute('data-field-input')){ editingField = null; render(); }
    });
    el.addEventListener('keydown', e=>{
      if(e.key==='Escape'){
        /* Reset to the original value first: removing the input from the DOM (via
           render()) forces a native blur, which fires 'change' if the value differs
           from focus-time — that would commit the discarded edit unless we revert it. */
        el.value = el.defaultValue;
        editingField = null;
        render();
      }
      else if(e.key==='Enter' && el.tagName!=='TEXTAREA'){ e.preventDefault(); el.blur(); }
    });
  });
  if(editingField){
    const activeInput = document.querySelector('[data-field-input="'+editingField+'"]');
    if(activeInput){ activeInput.focus(); if(activeInput.select) activeInput.select(); }
  }

  /* Category-specific extra fields: collapsed summary <-> expanded fields */
  document.querySelectorAll('[data-expand-fields]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); extraFieldsExpanded.add(el.getAttribute('data-expand-fields')); render(); });
  });
  document.querySelectorAll('[data-collapse-fields]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); extraFieldsExpanded.delete(el.getAttribute('data-collapse-fields')); editingField = null; render(); });
  });
}

document.getElementById('newBtn').addEventListener('click', ()=> openModal({type:'domain'}));
document.querySelectorAll('#healthTabs .tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('#healthTabs .tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    currentHealthFilter = tab.getAttribute('data-filter');
    render();
  });
});
document.getElementById('searchInput').addEventListener('input', (e)=>{ searchTerm = e.target.value; render(); });

/* ---- PWA: install prompt ---- */
let deferredInstall = null;
const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', e=>{
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async ()=>{
  if(!deferredInstall) return;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
  if(outcome === 'accepted') showToast('installing…');
});
window.addEventListener('appinstalled', ()=>{
  deferredInstall = null;
  installBtn.hidden = true;
  showToast('installed');
});

/* ---- PWA: service worker ---- */
if('serviceWorker' in navigator && location.protocol !== 'file:'){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{ /* offline support just stays off */ });
  });
}

/* ---- Boot ---- */
loadTheme();
loadDomains().then(()=>{
  /* manifest shortcut: ./?action=new */
  const params = new URLSearchParams(location.search);
  if(params.get('action') === 'new'){
    openModal({type:'domain'});
    history.replaceState(null, '', location.pathname);
  }
  if(!Store.persistent) showToast('storage blocked — changes won\'t be saved');
});
