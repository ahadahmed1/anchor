const STATUS_ORDER = ['not_started','in_progress','blocked','done'];
const STATUS_LABEL = {not_started:'Not started', in_progress:'In progress', blocked:'Blocked', done:'Done'};

let projects = [];
let currentFilter = 'all';
let globalView = 'list';       // 'list' | 'board'
let storyViewMode = 'tree';    // 'tree' | 'board' (for whichever project is expanded)
let expandedId = null;
let expandedEpics = new Set();
let expandedStories = new Set();
let searchTerm = '';

const grid = document.getElementById('grid');
const ledgerStrip = document.getElementById('ledgerStrip');
const toastEl = document.getElementById('toast');
const statusTabsEl = document.getElementById('statusTabs');

function showToast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(()=>toastEl.classList.remove('show'), 1800);
}

function uid(prefix){ return (prefix||'p') + '_' + Math.random().toString(36).slice(2,10); }

function nextProjectCode(){
  const nums = projects.map(p => parseInt((p.code||'P-000').split('-')[1],10)).filter(n=>!isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return 'P-' + String(max+1).padStart(3,'0');
}
function nextEpicCode(p){ return 'E-' + ((p.epics||[]).length + 1); }
function nextStoryCode(e){ return 'S-' + ((e.stories||[]).length + 1); }

function statusProgress(status){
  if(status==='done') return 100;
  if(status==='blocked') return 40;
  if(status==='in_progress') return 50;
  return 0;
}
function storyProgress(s){
  const tasks = s.tasks||[];
  if(tasks.length) return Math.round((tasks.filter(t=>t.done).length/tasks.length)*100);
  return statusProgress(s.status);
}
function epicProgress(e){
  const stories = e.stories||[];
  if(stories.length) return Math.round(stories.reduce((sum,s)=>sum+storyProgress(s),0)/stories.length);
  return statusProgress(e.status);
}
function projectProgress(p){
  const epics = p.epics||[];
  if(epics.length) return Math.round(epics.reduce((sum,e)=>sum+epicProgress(e),0)/epics.length);
  const tasks = p.tasks||[];
  if(tasks.length) return Math.round((tasks.filter(t=>t.done).length/tasks.length)*100);
  return statusProgress(p.status);
}
function collectAllTasks(p){
  let tasks = [...(p.tasks||[])];
  (p.epics||[]).forEach(e=> (e.stories||[]).forEach(s=> tasks.push(...(s.tasks||[]))));
  return tasks;
}
function breakdownSummary(p){
  const epics = p.epics||[];
  const storiesCount = epics.reduce((sum,e)=>sum+(e.stories||[]).length,0);
  const allTasks = collectAllTasks(p);
  if(epics.length===0 && (p.tasks||[]).length===0) return 'no breakdown yet';
  const parts=[];
  if(epics.length) parts.push(epics.length+' epic'+(epics.length!==1?'s':''));
  if(storiesCount) parts.push(storiesCount+' stor'+(storiesCount!==1?'ies':'y'));
  if(allTasks.length) parts.push(allTasks.filter(t=>t.done).length+'/'+allTasks.length+' tasks');
  return parts.join(' · ') || 'no breakdown yet';
}

function timeAgo(iso){
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

async function loadProjects(){
  try{
    const raw = await Store.get('projects');
    projects = raw ? JSON.parse(raw) : [];
  }catch(e){ projects = []; }
  render();
}
async function persist(){
  try{ await Store.set('projects', JSON.stringify(projects)); }
  catch(e){ showToast('save failed — storage blocked'); }
}

/* ---- Theme ---- */
async function loadTheme(){
  /* The inline script in index.html already set data-theme before first paint;
     this re-derives the same value to sync the toggle buttons. */
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

/* ---- Project CRUD ---- */
function createProject(){
  const p = {
    id: uid('p'), code: nextProjectCode(), name: 'New project', category: 'General',
    status: 'not_started', description: '', tasks: [], epics: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  projects.unshift(p);
  globalView = 'list';
  document.querySelectorAll('[data-global-view]').forEach(b=>b.classList.toggle('active', b.getAttribute('data-global-view')==='list'));
  expandedId = p.id;
  storyViewMode = 'tree';
  persist(); render();
  setTimeout(()=>{
    const el = document.querySelector(`[data-name-input="${p.id}"]`);
    if(el){ el.focus(); el.select(); }
  }, 30);
}
function updateProject(id, patch){
  const p = projects.find(x=>x.id===id);
  if(!p) return;
  Object.assign(p, patch, {updatedAt: new Date().toISOString()});
  persist(); render();
}
function deleteProject(id){
  projects = projects.filter(x=>x.id!==id);
  if(expandedId===id) expandedId = null;
  persist(); render();
}

/* ---- Flat project tasks (simple mode) ---- */
function addTask(pid, text){
  if(!text.trim()) return;
  const p = projects.find(x=>x.id===pid);
  if(!p) return;
  p.tasks = p.tasks || [];
  p.tasks.push({id: uid('t'), text: text.trim(), done:false});
  p.updatedAt = new Date().toISOString();
  persist(); render();
}
function toggleTask(pid, tid){
  const p = projects.find(x=>x.id===pid);
  const t = p && p.tasks.find(x=>x.id===tid);
  if(!t) return;
  t.done = !t.done; p.updatedAt = new Date().toISOString();
  persist(); render();
}
function removeTask(pid, tid){
  const p = projects.find(x=>x.id===pid);
  if(!p) return;
  p.tasks = p.tasks.filter(x=>x.id!==tid);
  p.updatedAt = new Date().toISOString();
  persist(); render();
}

/* ---- Epics ---- */
function addEpic(pid, name, status, description){
  if(!name.trim()) return;
  const p = projects.find(x=>x.id===pid);
  if(!p) return;
  p.epics = p.epics || [];
  const epic = {id: uid('e'), code: nextEpicCode(p), name: name.trim(), status: status||'not_started', description: description||'', stories:[]};
  p.epics.push(epic);
  p.updatedAt = new Date().toISOString();
  expandedEpics.add(epic.id);
  persist(); render();
}
function updateEpic(pid, eid, patch){
  const p = projects.find(x=>x.id===pid);
  const e = p && (p.epics||[]).find(x=>x.id===eid);
  if(!e) return;
  Object.assign(e, patch);
  p.updatedAt = new Date().toISOString();
  persist(); render();
}
function deleteEpic(pid, eid){
  const p = projects.find(x=>x.id===pid);
  if(!p) return;
  p.epics = (p.epics||[]).filter(x=>x.id!==eid);
  expandedEpics.delete(eid);
  p.updatedAt = new Date().toISOString();
  persist(); render();
}

/* ---- Stories ---- */
function addStory(pid, eid, name, status, description){
  if(!name.trim()) return;
  const p = projects.find(x=>x.id===pid);
  const e = p && (p.epics||[]).find(x=>x.id===eid);
  if(!e) return;
  e.stories = e.stories || [];
  const story = {id: uid('s'), code: nextStoryCode(e), name: name.trim(), status: status||'not_started', description: description||'', tasks:[]};
  e.stories.push(story);
  p.updatedAt = new Date().toISOString();
  expandedStories.add(story.id);
  persist(); render();
}
function updateStory(pid, eid, sid, patch){
  const p = projects.find(x=>x.id===pid);
  const e = p && (p.epics||[]).find(x=>x.id===eid);
  const s = e && (e.stories||[]).find(x=>x.id===sid);
  if(!s) return;
  Object.assign(s, patch);
  p.updatedAt = new Date().toISOString();
  persist(); render();
}
function deleteStory(pid, eid, sid){
  const p = projects.find(x=>x.id===pid);
  const e = p && (p.epics||[]).find(x=>x.id===eid);
  if(!e) return;
  e.stories = (e.stories||[]).filter(x=>x.id!==sid);
  expandedStories.delete(sid);
  p.updatedAt = new Date().toISOString();
  persist(); render();
}

/* ---- Story tasks ---- */
function addStoryTask(pid, eid, sid, text){
  if(!text.trim()) return;
  const p = projects.find(x=>x.id===pid);
  const e = p && (p.epics||[]).find(x=>x.id===eid);
  const s = e && (e.stories||[]).find(x=>x.id===sid);
  if(!s) return;
  s.tasks = s.tasks || [];
  s.tasks.push({id: uid('t'), text: text.trim(), done:false});
  p.updatedAt = new Date().toISOString();
  persist(); render();
}
function toggleStoryTask(pid, eid, sid, tid){
  const p = projects.find(x=>x.id===pid);
  const e = p && (p.epics||[]).find(x=>x.id===eid);
  const s = e && (e.stories||[]).find(x=>x.id===sid);
  const t = s && s.tasks.find(x=>x.id===tid);
  if(!t) return;
  t.done = !t.done; p.updatedAt = new Date().toISOString();
  persist(); render();
}
function removeStoryTask(pid, eid, sid, tid){
  const p = projects.find(x=>x.id===pid);
  const e = p && (p.epics||[]).find(x=>x.id===eid);
  const s = e && (e.stories||[]).find(x=>x.id===sid);
  if(!s) return;
  s.tasks = s.tasks.filter(x=>x.id!==tid);
  p.updatedAt = new Date().toISOString();
  persist(); render();
}

/* ---- Modal (add epic / story with details) ---- */
let modalState = null;
function openModal({type, pid, eid, name}){
  modalState = {type, pid: pid||null, eid: eid||null, name: name||'', status:'not_started', description:''};
  renderModal();
}
function closeModal(){ modalState = null; renderModal(); }
function renderModal(){
  const root = document.getElementById('modalRoot');
  if(!modalState){ root.innerHTML=''; return; }
  const project = projects.find(p=>p.id===modalState.pid);
  let subLabel = project ? `${project.code} — ${escapeHtml(project.name)}` : 'no project selected';
  if(modalState.type==='story'){
    const epic = project && (project.epics||[]).find(e=>e.id===modalState.eid);
    subLabel += epic ? ` / ${epic.code} — ${escapeHtml(epic.name)}` : ' / no epic selected';
  }
  root.innerHTML = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal">
        <div class="modal-title">${modalState.type==='epic' ? 'New epic' : 'New story'}</div>
        <div class="modal-sub">${subLabel}</div>
        <div class="field"><span class="field-label">Name</span><input type="text" id="modalName" value="${escapeAttr(modalState.name)}" placeholder="${modalState.type==='epic'?'Epic name':'Story name'}"></div>
        <div class="field"><span class="field-label">Status</span><select id="modalStatus">${statusOptions(modalState.status)}</select></div>
        <div class="field"><span class="field-label">Notes</span><textarea id="modalDesc" placeholder="Optional details...">${escapeHtml(modalState.description)}</textarea></div>
        <div class="modal-actions">
          <button class="modal-cancel" id="modalCancel">Cancel</button>
          <button class="modal-save" id="modalSave">Create ${modalState.type}</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('modalOverlay').addEventListener('click', e=>{ if(e.target.id==='modalOverlay') closeModal(); });
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalSave').addEventListener('click', submitModal);
  const nameEl = document.getElementById('modalName');
  nameEl.focus(); nameEl.select();
  nameEl.addEventListener('keydown', e=>{
    if(e.key==='Enter'){ submitModal(); }
    if(e.key==='Escape'){ closeModal(); }
  });
}
function submitModal(){
  const name = document.getElementById('modalName').value.trim();
  const status = document.getElementById('modalStatus').value;
  const description = document.getElementById('modalDesc').value;
  if(!name){ showToast('name is required'); return; }
  if(modalState.type==='epic'){
    if(!modalState.pid){ showToast('pick a project first'); return; }
    addEpic(modalState.pid, name, status, description);
    showToast('epic added');
  } else {
    if(!modalState.pid || !modalState.eid){ showToast('pick a project and epic first'); return; }
    addStory(modalState.pid, modalState.eid, name, status, description);
    showToast('story added');
  }
  closeModal();
}

/* ---- Quick add bar ---- */
let qaType = 'epic';
let qaProjectId = null;
let qaEpicId = null;
function populateQuickAdd(){
  const projSel = document.getElementById('qaProject');
  const epicSel = document.getElementById('qaEpic');
  const addBtn = document.getElementById('qaAdd');
  if(!projSel) return;
  if(projects.length){
    projSel.innerHTML = projects.map(p=>`<option value="${p.id}">${p.code} — ${escapeHtml(p.name)}</option>`).join('');
    qaProjectId = projects.find(p=>p.id===qaProjectId) ? qaProjectId : projects[0].id;
    projSel.value = qaProjectId;
  } else {
    projSel.innerHTML = '<option value="">No projects yet</option>';
    qaProjectId = null;
  }
  const project = projects.find(p=>p.id===qaProjectId);
  const epics = project ? (project.epics||[]) : [];
  if(epics.length){
    epicSel.innerHTML = epics.map(e=>`<option value="${e.id}">${e.code} — ${escapeHtml(e.name)}</option>`).join('');
    qaEpicId = epics.find(e=>e.id===qaEpicId) ? qaEpicId : epics[0].id;
    epicSel.value = qaEpicId;
  } else {
    epicSel.innerHTML = '<option value="">No epics — add one first</option>';
    qaEpicId = null;
  }
  epicSel.style.display = qaType==='story' ? 'inline-block' : 'none';
  addBtn.disabled = !qaProjectId || (qaType==='story' && !qaEpicId);
}
function quickAddSubmit(){
  const nameInput = document.getElementById('qaName');
  const name = nameInput.value.trim();
  if(!qaProjectId){ showToast('add a project first'); return; }
  if(!name){ nameInput.focus(); return; }
  if(qaType==='epic'){
    addEpic(qaProjectId, name);
    showToast('epic added');
  } else {
    if(!qaEpicId){ showToast('add an epic first'); return; }
    addStory(qaProjectId, qaEpicId, name);
    showToast('story added');
  }
  nameInput.value='';
  nameInput.focus();
}
document.querySelectorAll('[data-qa-type]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    qaType = btn.getAttribute('data-qa-type');
    document.querySelectorAll('[data-qa-type]').forEach(b=>b.classList.toggle('active', b===btn));
    populateQuickAdd();
  });
});
document.getElementById('qaProject').addEventListener('change', e=>{ qaProjectId = e.target.value; populateQuickAdd(); });
document.getElementById('qaEpic').addEventListener('change', e=>{ qaEpicId = e.target.value; populateQuickAdd(); });
document.getElementById('qaName').addEventListener('keydown', e=>{ if(e.key==='Enter'){ quickAddSubmit(); } });
document.getElementById('qaAdd').addEventListener('click', quickAddSubmit);
document.getElementById('qaDetails').addEventListener('click', ()=>{
  const name = document.getElementById('qaName').value;
  if(qaType==='epic'){ openModal({type:'epic', pid:qaProjectId, name}); }
  else { openModal({type:'story', pid:qaProjectId, eid:qaEpicId, name}); }
});

/* ---- Render helpers ---- */
function renderLedgerStrip(){
  const total = projects.length;
  const counts = {not_started:0,in_progress:0,blocked:0,done:0};
  projects.forEach(p=> counts[p.status] = (counts[p.status]||0)+1);
  const avgProgress = total ? Math.round(projects.reduce((s,p)=>s+projectProgress(p),0)/total) : 0;
  ledgerStrip.innerHTML = `
    <div class="ledger-cell"><div class="ledger-num">${total}</div><div class="ledger-label">Total</div></div>
    <div class="ledger-cell n-progress"><div class="ledger-num">${counts.in_progress}</div><div class="ledger-label">In progress</div></div>
    <div class="ledger-cell n-blocked"><div class="ledger-num">${counts.blocked}</div><div class="ledger-label">Blocked</div></div>
    <div class="ledger-cell n-done"><div class="ledger-num">${counts.done}</div><div class="ledger-label">Done</div></div>
    <div class="ledger-cell"><div class="ledger-num">${avgProgress}%</div><div class="ledger-label">Avg progress</div></div>
  `;
}
function segBar(pct, status){
  const totalSegs = 10;
  const filled = Math.round((pct/100)*totalSegs);
  let html = '';
  for(let i=0;i<totalSegs;i++) html += `<div class="seg ${i<filled?'filled '+status:''}"></div>`;
  return html;
}
function statusOptions(current){
  return STATUS_ORDER.map(s=>`<option value="${s}" ${current===s?'selected':''}>${STATUS_LABEL[s]}</option>`).join('');
}
function matchesFilter(p){
  if(currentFilter!=='all' && p.status!==currentFilter) return false;
  if(searchTerm){
    const hay = (p.name+' '+p.category+' '+p.description).toLowerCase();
    if(!hay.includes(searchTerm.toLowerCase())) return false;
  }
  return true;
}
function escapeHtml(str){
  return (str||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function escapeAttr(str){ return escapeHtml(str); }

/* ---- Main render ---- */
function render(){
  renderLedgerStrip();
  populateQuickAdd();
  statusTabsEl.classList.toggle('disabled', globalView==='board');

  if(globalView==='board'){
    grid.classList.add('board-mode');
    grid.innerHTML = renderGlobalBoard();
  } else {
    grid.classList.remove('board-mode');
    const visible = projects.filter(matchesFilter);
    if(visible.length===0){
      grid.innerHTML = `<div class="empty-state">
        <div class="em-title">${projects.length===0 ? 'No projects yet' : 'Nothing matches that filter'}</div>
        <div>${projects.length===0 ? 'Add your first project to start tracking it.' : 'Try a different status or search term.'}</div>
      </div>`;
      attachHandlers();
      return;
    }
    grid.innerHTML = visible.map(p=>{
      const pct = projectProgress(p);
      const isOpen = expandedId===p.id;
      return `
        <div class="card">
          <div class="status-stripe ${p.status}"></div>
          <div class="card-body" data-toggle="${p.id}">
            <div class="card-top">
              <div class="card-titles">
                <div class="card-code">${p.code}</div>
                <div class="card-name">${escapeHtml(p.name)}</div>
              </div>
              <div class="badge ${p.status}">${STATUS_LABEL[p.status]}</div>
            </div>
            <div class="card-cat">${escapeHtml(p.category||'General')}</div>
            ${p.description ? `<div class="card-desc">${escapeHtml(p.description)}</div>` : ''}
            <div class="progress-row">
              <div class="segbar">${segBar(pct, p.status)}</div>
              <div class="progress-pct">${pct}%</div>
            </div>
            <div class="card-meta">
              <div class="task-count">${breakdownSummary(p)}</div>
              <div class="updated">${timeAgo(p.updatedAt)}</div>
            </div>
          </div>
          ${isOpen ? renderDetail(p) : ''}
        </div>
      `;
    }).join('');
  }
  attachHandlers();
}

function renderGlobalBoard(){
  const term = searchTerm.toLowerCase();
  const filtered = projects.filter(p=> !term || (p.name+' '+p.category+' '+p.description).toLowerCase().includes(term));
  let html = '<div class="board">';
  STATUS_ORDER.forEach(status=>{
    const items = filtered.filter(p=>p.status===status);
    html += `<div class="board-col">
      <div class="board-col-head"><span class="board-col-dot ${status}"></span>${STATUS_LABEL[status]}<span class="board-col-count">${items.length}</span></div>
      <div class="board-col-body" data-drop-zone="${status}">
        ${items.length ? items.map(p=>renderBoardProjectCard(p)).join('') : '<div class="empty-hint">nothing here</div>'}
      </div>
    </div>`;
  });
  html += '</div>';
  return html;
}
function renderBoardProjectCard(p){
  const pct = projectProgress(p);
  return `<div class="board-card" draggable="true" data-drag-project="${p.id}">
    <div class="board-card-code">${p.code}</div>
    <div class="board-card-name">${escapeHtml(p.name)}</div>
    <div class="board-card-sub">${escapeHtml(p.category||'General')} · ${pct}% · ${breakdownSummary(p)}</div>
  </div>`;
}

function renderDetail(p){
  const tasksHtml = (p.tasks||[]).map(t=>`
    <div class="task-item">
      <div class="task-check ${t.done?'checked':''}" data-toggle-task="${p.id}|${t.id}">
        <svg viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-6" stroke="#0B1512" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="task-text ${t.done?'done':''}">${escapeHtml(t.text)}</div>
      <button class="task-del" data-remove-task="${p.id}|${t.id}">&times;</button>
    </div>
  `).join('');

  const hasEpics = (p.epics||[]).length > 0;

  return `
    <div class="detail">
      <div class="field">
        <span class="field-label">Name</span>
        <input type="text" value="${escapeAttr(p.name)}" data-edit-name="${p.id}" data-name-input="${p.id}">
      </div>
      <div class="field-row">
        <div class="field">
          <span class="field-label">Category</span>
          <input type="text" value="${escapeAttr(p.category||'')}" data-edit-category="${p.id}">
        </div>
        <div class="field">
          <span class="field-label">Status</span>
          <select data-edit-status="${p.id}">${statusOptions(p.status)}</select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Notes</span>
        <textarea data-edit-description="${p.id}" placeholder="What is this project, and where does it stand?">${escapeHtml(p.description||'')}</textarea>
      </div>

      <div class="field">
        <span class="field-label">Quick tasks (for simple projects)</span>
        <div class="tasks-list">${tasksHtml}</div>
        <div class="add-task-row"><input type="text" placeholder="Add a task and press enter" data-add-task="${p.id}"></div>
      </div>

      <div class="subsection">
        <div class="subsection-head">
          <span class="field-label">Epics & stories</span>
          <div class="seg-toggle mini">
            <button class="seg-opt ${storyViewMode==='tree'?'active':''}" data-story-view="tree">tree</button>
            <button class="seg-opt ${storyViewMode==='board'?'active':''}" data-story-view="board">board</button>
          </div>
        </div>
        ${storyViewMode==='board' ? renderStoryBoard(p) : `
          <div class="node-list">
            ${hasEpics ? (p.epics||[]).map(e=>renderEpicRow(p,e)).join('') : '<div class="empty-hint">No epics yet — break this project into epics and stories.</div>'}
          </div>
          <button class="add-node-btn" data-open-epic-modal="${p.id}">+ Add epic</button>
        `}
      </div>

      <div class="detail-footer">
        <button class="delete-btn" data-delete="${p.id}">delete project</button>
        <button class="close-btn" data-collapse="${p.id}">Done editing</button>
      </div>
    </div>
  `;
}

function renderStoryBoard(p){
  let allStories = [];
  (p.epics||[]).forEach(e=> (e.stories||[]).forEach(s=> allStories.push(Object.assign({}, s, {_epicCode:e.code, _epicId:e.id}))));
  let html = '<div class="board story-board">';
  STATUS_ORDER.forEach(status=>{
    const items = allStories.filter(s=>s.status===status);
    html += `<div class="board-col">
      <div class="board-col-head"><span class="board-col-dot ${status}"></span>${STATUS_LABEL[status]}<span class="board-col-count">${items.length}</span></div>
      <div class="board-col-body" data-drop-zone-story="${p.id}|${status}">
        ${items.length ? items.map(s=>renderBoardStoryCard(p,s)).join('') : '<div class="empty-hint">nothing here</div>'}
      </div>
    </div>`;
  });
  html += '</div>';
  if(allStories.length===0) html += '<div class="empty-hint">Switch to tree view to add epics and stories first.</div>';
  return html;
}
function renderBoardStoryCard(p, s){
  const pct = storyProgress(s);
  const tasks = s.tasks||[];
  return `<div class="board-card" draggable="true" data-drag-story="${p.id}|${s._epicId}|${s.id}">
    <div class="board-card-code">${s._epicCode} · ${s.code}</div>
    <div class="board-card-name">${escapeHtml(s.name)}</div>
    <div class="board-card-sub">${tasks.length ? tasks.filter(t=>t.done).length+'/'+tasks.length+' tasks' : pct+'%'}</div>
  </div>`;
}

function renderEpicRow(p, e){
  const isOpen = expandedEpics.has(e.id);
  const pct = epicProgress(e);
  const storiesHtml = (e.stories||[]).length
    ? (e.stories||[]).map(s=>renderStoryRow(p,e,s)).join('')
    : '<div class="empty-hint">No stories yet.</div>';
  return `
    <div class="node epic-node">
      <div class="node-stripe ${e.status}"></div>
      <div class="node-row" data-toggle-epic="${e.id}">
        <span class="node-caret ${isOpen?'open':''}">&rsaquo;</span>
        <span class="node-code">${e.code}</span>
        <span class="node-name">${escapeHtml(e.name)}</span>
        <span class="node-badge ${e.status}">${STATUS_LABEL[e.status]}</span>
        <span class="node-pct">${pct}%</span>
      </div>
      ${isOpen ? `
        <div class="node-detail">
          <div class="field-row">
            <div class="field"><span class="field-label">Name</span><input type="text" value="${escapeAttr(e.name)}" data-edit-epic-name="${p.id}|${e.id}"></div>
            <div class="field"><span class="field-label">Status</span><select data-edit-epic-status="${p.id}|${e.id}">${statusOptions(e.status)}</select></div>
          </div>
          <div class="field"><span class="field-label">Notes</span><textarea data-edit-epic-desc="${p.id}|${e.id}" placeholder="What does this epic cover?">${escapeHtml(e.description||'')}</textarea></div>
          <div class="subsection">
            <span class="field-label">Stories</span>
            <div class="node-list">${storiesHtml}</div>
            <button class="add-node-btn" data-open-story-modal="${p.id}|${e.id}">+ Add story</button>
          </div>
          <div class="node-footer"><button class="delete-btn" data-delete-epic="${p.id}|${e.id}">delete epic</button></div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderStoryRow(p, e, s){
  const isOpen = expandedStories.has(s.id);
  const pct = storyProgress(s);
  const tasks = s.tasks||[];
  const doneCount = tasks.filter(t=>t.done).length;
  const tasksHtml = tasks.map(t=>`
    <div class="task-item">
      <div class="task-check ${t.done?'checked':''}" data-toggle-story-task="${p.id}|${e.id}|${s.id}|${t.id}">
        <svg viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-6" stroke="#0B1512" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="task-text ${t.done?'done':''}">${escapeHtml(t.text)}</div>
      <button class="task-del" data-remove-story-task="${p.id}|${e.id}|${s.id}|${t.id}">&times;</button>
    </div>
  `).join('');
  return `
    <div class="node story-node">
      <div class="node-stripe ${s.status}"></div>
      <div class="node-row" data-toggle-story="${s.id}">
        <span class="node-caret ${isOpen?'open':''}">&rsaquo;</span>
        <span class="node-code">${s.code}</span>
        <span class="node-name">${escapeHtml(s.name)}</span>
        <span class="node-badge ${s.status}">${STATUS_LABEL[s.status]}</span>
        <span class="node-pct">${tasks.length ? doneCount+'/'+tasks.length : pct+'%'}</span>
      </div>
      ${isOpen ? `
        <div class="node-detail">
          <div class="field-row">
            <div class="field"><span class="field-label">Name</span><input type="text" value="${escapeAttr(s.name)}" data-edit-story-name="${p.id}|${e.id}|${s.id}"></div>
            <div class="field"><span class="field-label">Status</span><select data-edit-story-status="${p.id}|${e.id}|${s.id}">${statusOptions(s.status)}</select></div>
          </div>
          <div class="field"><span class="field-label">Notes</span><textarea data-edit-story-desc="${p.id}|${e.id}|${s.id}" placeholder="Details for this story...">${escapeHtml(s.description||'')}</textarea></div>
          <div class="tasks-list">${tasksHtml}</div>
          <div class="add-task-row"><input type="text" placeholder="Add a task and press enter" data-add-story-task="${p.id}|${e.id}|${s.id}"></div>
          <div class="node-footer"><button class="delete-btn" data-delete-story="${p.id}|${e.id}|${s.id}">delete story</button></div>
        </div>
      ` : ''}
    </div>
  `;
}

function attachHandlers(){
  document.querySelectorAll('[data-toggle]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.getAttribute('data-toggle');
      if(expandedId !== id){ storyViewMode = 'tree'; }
      expandedId = expandedId===id ? null : id;
      render();
    });
  });
  document.querySelectorAll('[data-collapse]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); expandedId = null; render(); });
  });
  document.querySelectorAll('[data-delete]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const id = el.getAttribute('data-delete');
      const p = projects.find(x=>x.id===id);
      if(confirm(`Delete "${p?p.name:'this project'}"? This can't be undone.`)){
        deleteProject(id); showToast('project deleted');
      }
    });
  });
  document.querySelectorAll('[data-edit-name]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=> updateProject(el.getAttribute('data-edit-name'), {name: el.value || 'Untitled project'}));
  });
  document.querySelectorAll('[data-edit-category]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=> updateProject(el.getAttribute('data-edit-category'), {category: el.value}));
  });
  document.querySelectorAll('[data-edit-status]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=> updateProject(el.getAttribute('data-edit-status'), {status: el.value}));
  });
  document.querySelectorAll('[data-edit-description]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=> updateProject(el.getAttribute('data-edit-description'), {description: el.value}));
  });
  document.querySelectorAll('[data-add-task]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('keydown', e=>{ if(e.key==='Enter'){ addTask(el.getAttribute('data-add-task'), el.value); el.value=''; } });
  });
  document.querySelectorAll('[data-toggle-task]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); const [pid,tid]=el.getAttribute('data-toggle-task').split('|'); toggleTask(pid,tid); });
  });
  document.querySelectorAll('[data-remove-task]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); const [pid,tid]=el.getAttribute('data-remove-task').split('|'); removeTask(pid,tid); });
  });

  document.querySelectorAll('[data-story-view]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      storyViewMode = el.getAttribute('data-story-view');
      render();
    });
  });

  document.querySelectorAll('[data-toggle-epic]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.getAttribute('data-toggle-epic');
      if(expandedEpics.has(id)) expandedEpics.delete(id); else expandedEpics.add(id);
      render();
    });
  });
  document.querySelectorAll('[data-open-epic-modal]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); openModal({type:'epic', pid: el.getAttribute('data-open-epic-modal')}); });
  });
  document.querySelectorAll('[data-open-story-modal]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [pid,eid] = el.getAttribute('data-open-story-modal').split('|');
      openModal({type:'story', pid, eid});
    });
  });
  document.querySelectorAll('[data-edit-epic-name]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [pid,eid]=el.getAttribute('data-edit-epic-name').split('|'); updateEpic(pid,eid,{name: el.value||'Untitled epic'}); });
  });
  document.querySelectorAll('[data-edit-epic-status]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [pid,eid]=el.getAttribute('data-edit-epic-status').split('|'); updateEpic(pid,eid,{status: el.value}); });
  });
  document.querySelectorAll('[data-edit-epic-desc]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [pid,eid]=el.getAttribute('data-edit-epic-desc').split('|'); updateEpic(pid,eid,{description: el.value}); });
  });
  document.querySelectorAll('[data-delete-epic]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [pid,eid] = el.getAttribute('data-delete-epic').split('|');
      if(confirm('Delete this epic and all its stories?')){ deleteEpic(pid,eid); showToast('epic deleted'); }
    });
  });

  document.querySelectorAll('[data-toggle-story]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.getAttribute('data-toggle-story');
      if(expandedStories.has(id)) expandedStories.delete(id); else expandedStories.add(id);
      render();
    });
  });
  document.querySelectorAll('[data-edit-story-name]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [pid,eid,sid]=el.getAttribute('data-edit-story-name').split('|'); updateStory(pid,eid,sid,{name: el.value||'Untitled story'}); });
  });
  document.querySelectorAll('[data-edit-story-status]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [pid,eid,sid]=el.getAttribute('data-edit-story-status').split('|'); updateStory(pid,eid,sid,{status: el.value}); });
  });
  document.querySelectorAll('[data-edit-story-desc]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('change', ()=>{ const [pid,eid,sid]=el.getAttribute('data-edit-story-desc').split('|'); updateStory(pid,eid,sid,{description: el.value}); });
  });
  document.querySelectorAll('[data-delete-story]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const [pid,eid,sid] = el.getAttribute('data-delete-story').split('|');
      if(confirm('Delete this story and its tasks?')){ deleteStory(pid,eid,sid); showToast('story deleted'); }
    });
  });
  document.querySelectorAll('[data-add-story-task]').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
    el.addEventListener('keydown', e=>{ if(e.key==='Enter'){ const [pid,eid,sid]=el.getAttribute('data-add-story-task').split('|'); addStoryTask(pid,eid,sid,el.value); el.value=''; } });
  });
  document.querySelectorAll('[data-toggle-story-task]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); const [pid,eid,sid,tid]=el.getAttribute('data-toggle-story-task').split('|'); toggleStoryTask(pid,eid,sid,tid); });
  });
  document.querySelectorAll('[data-remove-story-task]').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); const [pid,eid,sid,tid]=el.getAttribute('data-remove-story-task').split('|'); removeStoryTask(pid,eid,sid,tid); });
  });

  document.querySelectorAll('.detail, .node-detail').forEach(el=>{
    el.addEventListener('click', e=>e.stopPropagation());
  });

  /* ---- Drag & drop for boards ---- */
  document.querySelectorAll('[data-drag-project]').forEach(el=>{
    el.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', JSON.stringify({type:'project', id: el.getAttribute('data-drag-project')}));
    });
    el.addEventListener('click', ()=>{
      const id = el.getAttribute('data-drag-project');
      globalView = 'list';
      document.querySelectorAll('[data-global-view]').forEach(b=>b.classList.toggle('active', b.getAttribute('data-global-view')==='list'));
      storyViewMode = 'tree';
      expandedId = id;
      render();
    });
  });
  document.querySelectorAll('[data-drag-story]').forEach(el=>{
    el.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', JSON.stringify({type:'story', key: el.getAttribute('data-drag-story')}));
    });
    el.addEventListener('click', ()=>{
      const [pid,eid,sid] = el.getAttribute('data-drag-story').split('|');
      storyViewMode = 'tree';
      expandedEpics.add(eid);
      expandedStories.add(sid);
      render();
    });
  });
  document.querySelectorAll('[data-drop-zone]').forEach(zone=>{
    zone.addEventListener('dragover', e=>{ e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()=> zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e=>{
      e.preventDefault(); zone.classList.remove('drag-over');
      let data = {};
      try{ data = JSON.parse(e.dataTransfer.getData('text/plain')||'{}'); }catch(err){}
      const newStatus = zone.getAttribute('data-drop-zone');
      if(data.type==='project'){ updateProject(data.id, {status:newStatus}); showToast('status updated'); }
    });
  });
  document.querySelectorAll('[data-drop-zone-story]').forEach(zone=>{
    zone.addEventListener('dragover', e=>{ e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()=> zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e=>{
      e.preventDefault(); zone.classList.remove('drag-over');
      let data = {};
      try{ data = JSON.parse(e.dataTransfer.getData('text/plain')||'{}'); }catch(err){}
      const [, newStatus] = zone.getAttribute('data-drop-zone-story').split('|');
      if(data.type==='story'){
        const [dpid,eid,sid] = data.key.split('|');
        updateStory(dpid, eid, sid, {status:newStatus});
        showToast('status updated');
      }
    });
  });
}

document.getElementById('newBtn').addEventListener('click', createProject);
document.querySelectorAll('.tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.getAttribute('data-filter');
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
loadProjects().then(()=>{
  /* manifest shortcut: ./?action=new */
  const params = new URLSearchParams(location.search);
  if(params.get('action') === 'new'){
    createProject();
    history.replaceState(null, '', location.pathname);
  }
  if(!Store.persistent) showToast('storage blocked — changes won\'t be saved');
});
