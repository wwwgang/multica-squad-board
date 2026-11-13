const $ = (sel) => document.querySelector(sel);

const state = {
  workspaces: [],
  workspaceId: localStorage.getItem('msb.workspace') || '',
  overview: null,
  squadId: '',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function initials(name) {
  const clean = String(name || '?').trim();
  return clean.slice(0, 2).toUpperCase();
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

const agentStatus = (a) => (a && a.status === 'working' ? 'working' : a ? 'idle' : 'offline');
const statusText = { working: '工作中', idle: '空闲', offline: '未知' };

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function toast(message, { error = false, detail = '' } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `${esc(message)}${detail ? `<small>${esc(detail)}</small>` : ''}`;
  $('#toast-stack').appendChild(el);
  setTimeout(() => el.remove(), error ? 8000 : 4500);
}

const currentWorkspace = () => state.workspaces.find((w) => w.id === state.workspaceId);
const currentSquad = () => state.overview?.squads.find((s) => s.id === state.squadId) || state.overview?.squads[0];

function workspaceIssuesUrl() {
  const ws = currentWorkspace();
  const appUrl = state.overview?.appUrl;
  return appUrl && ws ? `${appUrl}/${ws.slug}/issues` : '';
}

function avatarHtml(agent, name, { leader = false, large = false } = {}) {
  const cls = `avatar${large ? ' large' : ''}${leader ? ' leader-avatar' : ''}`;
  const status = agentStatus(agent);
  const img = agent?.avatarUrl ? `<img src="${esc(agent.avatarUrl)}" alt="" />` : esc(initials(name));
  return `<div class="${cls}">${img}<span class="status-dot ${status}"></span></div>`;
}

/* ---------------- data ---------------- */

async function loadWorkspaces() {
  state.workspaces = await api('/api/workspaces');
  if (!state.workspaces.find((w) => w.id === state.workspaceId)) {
    state.workspaceId = state.workspaces[0]?.id || '';
  }
  const select = $('#workspace-select');
  select.innerHTML = state.workspaces
    .map((w) => `<option value="${esc(w.id)}" ${w.id === state.workspaceId ? 'selected' : ''}>${esc(w.name)}</option>`)
    .join('');
}

async function loadOverview(refresh = false) {
  const params = new URLSearchParams();
  if (state.workspaceId) params.set('workspace', state.workspaceId);
  if (refresh) params.set('refresh', '1');
  const data = await api(`/api/overview?${params}`);
  state.overview = data;
  if (!data.squads.find((s) => s.id === state.squadId)) {
    state.squadId = data.squads[0]?.id || '';
  }
  render();
}

async function refresh(refresh = true) {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  try {
    await loadOverview(refresh);
  } catch (err) {
    toast('加载失败', { error: true, detail: err.message });
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- render ---------------- */

function render() {
  renderStats();
  renderTabs();
  renderOrgChart();
  renderCards();
  renderIssues();
  renderAssigneeOptions();
}

function renderStats() {
  const ov = state.overview;
  const squads = ov.squads.length;
  const memberIds = new Set();
  ov.squads.forEach((s) => s.members.forEach((m) => memberIds.add(m.memberId)));
  const working = ov.agents.filter((a) => a.status === 'working').length;
  const open = ov.squads.reduce((n, s) => n + s.openIssues, 0)
    + ov.agents.reduce((n, a) => n + a.openIssues, 0);
  $('#stats').innerHTML = [
    { num: squads, label: '小队', cls: '' },
    { num: memberIds.size, label: '小队成员', cls: '' },
    { num: working, label: '工作中的智能体', cls: 'accent' },
    { num: open, label: '未结任务（含直接指派）', cls: 'teal' },
  ].map((s) => `<div class="stat"><div class="stat-num ${s.cls}">${s.num}</div><div class="stat-label">${s.label}</div></div>`).join('');
}

function renderTabs() {
  const squads = state.overview.squads;
  $('#squad-tabs').innerHTML = squads.length > 1
    ? squads.map((s) => `<button class="squad-tab ${s.id === currentSquad()?.id ? 'active' : ''}" data-squad="${esc(s.id)}">${esc(s.name)}</button>`).join('')
    : '';
  document.querySelectorAll('.squad-tab').forEach((btn) => {
    btn.onclick = () => {
      state.squadId = btn.dataset.squad;
      render();
    };
  });
}

function nodeHtml(member) {
  const agent = member.agent;
  const name = agent?.name || (member.type === 'agent' ? '未知智能体' : '人类成员');
  const role = member.isLeader ? '队长' : member.role || agent?.description || (member.type === 'agent' ? '成员' : '人类成员');
  return `
    <div class="org-node ${member.isLeader ? 'leader' : ''}" data-node="${esc(member.memberId)}" data-agent="${esc(agent?.id || '')}" title="${esc(name)}">
      ${avatarHtml(agent, name, { leader: member.isLeader, large: member.isLeader })}
      <div class="node-text">
        <div class="node-name">${esc(name)}${member.isLeader ? '<span class="leader-badge">队长</span>' : ''}</div>
        <div class="node-role">${esc(role)}</div>
      </div>
    </div>`;
}

function renderOrgChart() {
  const squad = currentSquad();
  const chart = $('#org-chart');
  if (!squad) {
    chart.innerHTML = '<div class="empty">当前工作区还没有小队。在 Multica 的「团队 → 小队」里创建一个，再回来看看。</div>';
    $('#org-sub').textContent = '';
    return;
  }
  $('#org-sub').textContent = `${squad.name} · ${squad.members.length} 名成员 · 未结 ${squad.openIssues} / 进行中 ${squad.activeIssues}`;
  const leader = squad.members.find((m) => m.isLeader);
  const members = squad.members.filter((m) => !m.isLeader);
  chart.innerHTML = `
    <svg class="org-svg" aria-hidden="true"></svg>
    <div class="org-level leader-level">${leader ? nodeHtml(leader) : '<div class="empty">未设置队长</div>'}</div>
    <div class="org-level member-level">
      ${members.map((m, i) => nodeHtml(m)).join('') || '<div class="empty">还没有其他成员</div>'}
    </div>`;
  chart.querySelectorAll('.org-node').forEach((node, i) => {
    node.style.animationDelay = `${i * 35}ms`;
    node.onclick = () => {
      const agentId = node.dataset.agent;
      if (!agentId) return;
      const card = document.querySelector(`.member-card[data-agent="${agentId}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('flash');
        setTimeout(() => card.classList.remove('flash'), 1600);
      }
    };
  });
  requestAnimationFrame(drawConnectors);
}

function drawConnectors() {
  const chart = $('#org-chart');
  const svg = chart.querySelector('.org-svg');
  const leader = chart.querySelector('.leader-level .org-node');
  if (!svg || !leader) return;
  const base = chart.getBoundingClientRect();
  const pos = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.left - base.left + chart.scrollLeft,
      y: r.top - base.top + chart.scrollTop,
      w: r.width,
      h: r.height,
    };
  };
  const from = pos(leader);
  const parts = [];
  chart.querySelectorAll('.member-level .org-node').forEach((node) => {
    const to = pos(node);
    const x1 = from.x + from.w / 2;
    const y1 = from.y + from.h;
    const x2 = to.x + to.w / 2;
    const y2 = to.y;
    const mid = (y1 + y2) / 2;
    parts.push(`<path d="M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}" />`);
    parts.push(`<circle cx="${x2}" cy="${y2}" r="2.6" />`);
  });
  svg.setAttribute('width', chart.scrollWidth);
  svg.setAttribute('height', chart.scrollHeight);
  svg.setAttribute('viewBox', `0 0 ${chart.scrollWidth} ${chart.scrollHeight}`);
  svg.innerHTML = parts.join('');
}

function renderCards() {
  const squad = currentSquad();
  const grid = $('#card-grid');
  if (!squad) {
    grid.innerHTML = '';
    $('#cards-sub').textContent = '';
    return;
  }
  $('#cards-sub').textContent = '点击组织图节点可定位到对应卡片';
  grid.innerHTML = squad.members.map((m) => {
    const agent = m.agent;
    const name = agent?.name || (m.type === 'agent' ? '未知智能体' : '人类成员');
    const status = agentStatus(agent);
    const role = m.isLeader ? '队长' : m.role || '成员';
    const runtime = agent?.runtime?.name || (agent?.runtimeMode === 'cloud' ? '云端运行时' : '');
    return `
      <article class="member-card" data-agent="${esc(agent?.id || '')}">
        <div class="member-head">
          ${avatarHtml(agent, name, { leader: m.isLeader, large: true })}
          <div class="node-text">
            <div class="member-name">${esc(name)}</div>
            <div class="member-role">${esc(role)}</div>
          </div>
        </div>
        <p class="member-desc">${esc(agent?.description || m.role || '这个成员还没有填写描述。')}</p>
        <div class="chip-row">
          <span class="chip ${status}">${statusText[status]}</span>
          ${agent?.model ? `<span class="chip model">${esc(agent.model)}</span>` : ''}
          ${runtime ? `<span class="chip" title="运行时">${esc(runtime)}</span>` : ''}
        </div>
        <div class="member-foot">
          <span class="member-stats">未结 <strong>${agent?.openIssues ?? 0}</strong> · 进行中 <strong>${agent?.activeIssues ?? 0}</strong> · ${relTime(agent?.updatedAt)}</span>
          ${agent ? `<button class="btn btn-small" data-dispatch="${esc(agent.id)}">派给 TA</button>` : ''}
        </div>
      </article>`;
  }).join('');
  grid.querySelectorAll('[data-dispatch]').forEach((btn) => {
    btn.onclick = () => openModal(btn.dataset.dispatch);
  });
}

function renderIssues() {
  const list = $('#issue-list');
  const issues = state.overview.recentIssues;
  const squadName = (id) => state.overview.squads.find((s) => s.id === id)?.name;
  const agentName = (id) => state.overview.agents.find((a) => a.id === id)?.name;
  const url = workspaceIssuesUrl();
  list.innerHTML = issues.length ? issues.map((i) => {
    const assignee = i.assigneeType === 'squad' ? squadName(i.assigneeId) : agentName(i.assigneeId);
    return `
      <div class="issue-item">
        <div class="issue-top">
          <span class="issue-id">${esc(i.identifier || i.id.slice(0, 8))}</span>
          <span class="issue-status ${esc(i.status)}">${esc(i.status)}</span>
        </div>
        <div class="issue-title">${esc(i.title)}</div>
        <div class="issue-meta">${esc(assignee || '未分配')} · ${relTime(i.updatedAt)}</div>
      </div>`;
  }).join('') : '<div class="empty">没有未结任务</div>';
  if (url) {
    list.insertAdjacentHTML('beforeend', `<a class="issue-item" href="${esc(url)}" target="_blank" rel="noreferrer" style="color:var(--blue);font-size:12.5px">在 Multica 中打开工作区 ↗</a>`);
  }
}

/* ---------------- dispatch ---------------- */

function renderAssigneeOptions() {
  const select = $('#assignee-select');
  const prev = select.value;
  const squads = state.overview?.squads || [];
  const agents = state.overview?.agents || [];
  const squadAgents = new Set((currentSquad()?.members || []).map((m) => m.memberId));
  const inSquad = agents.filter((a) => squadAgents.has(a.id));
  const others = agents.filter((a) => !squadAgents.has(a.id));
  const opt = (id, label) => `<option value="${esc(id)}">${esc(label)}</option>`;
  select.innerHTML = `
    <optgroup label="小队（唤醒队长，由队长分派）">
      ${squads.map((s) => opt(s.id, s.name)).join('')}
    </optgroup>
    <optgroup label="本小队成员（直接运行）">
      ${inSquad.map((a) => opt(a.id, a.name)).join('')}
    </optgroup>
    ${others.length ? `<optgroup label="其他智能体">${others.map((a) => opt(a.id, a.name)).join('')}</optgroup>` : ''}`;
  if (prev && select.querySelector(`option[value="${CSS.escape(prev)}"]`)) select.value = prev;
  updateAssigneeNote();
}

function updateAssigneeNote() {
  const id = $('#assignee-select').value;
  const squad = state.overview?.squads.find((s) => s.id === id);
  $('#assignee-note').textContent = squad
    ? '创建后小队成为负责人，只唤醒队长一次运行，由队长阅读上下文后 @ 成员分派。'
    : '创建后该智能体成为负责人，直接入队一次运行。请确保标题和描述包含足够上下文。';
}

function openModal(assigneeId) {
  if (!state.overview) return;
  renderAssigneeOptions();
  if (assigneeId) $('#assignee-select').value = assigneeId;
  else if (currentSquad()) $('#assignee-select').value = currentSquad().id;
  updateAssigneeNote();
  $('#modal-mask').hidden = false;
  setTimeout(() => $('#issue-title').focus(), 60);
}

function closeModal() {
  $('#modal-mask').hidden = true;
  $('#dispatch-form').reset();
  $('#submit-btn').disabled = false;
  $('#submit-btn').textContent = '创建并派活';
}

async function submitDispatch(event) {
  event.preventDefault();
  const btn = $('#submit-btn');
  const title = $('#issue-title').value.trim();
  if (!title) return;
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const { issue } = await api('/api/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: state.workspaceId,
        title,
        description: $('#issue-desc').value,
        assigneeId: $('#assignee-select').value,
      }),
    });
    closeModal();
    toast(`已创建 ${issue.identifier || '任务'} 并派活`, { detail: issue.title || title });
    await loadOverview(true);
  } catch (err) {
    toast('派活失败', { error: true, detail: err.message });
    btn.disabled = false;
    btn.textContent = '创建并派活';
  }
}

/* ---------------- wiring ---------------- */

$('#refresh-btn').onclick = () => refresh(true);
$('#dispatch-btn').onclick = () => openModal();
$('#workspace-select').onchange = async (e) => {
  state.workspaceId = e.target.value;
  state.squadId = '';
  localStorage.setItem('msb.workspace', state.workspaceId);
  await refresh(true);
};
$('#modal-close').onclick = closeModal;
$('#modal-cancel').onclick = closeModal;
$('#modal-mask').onclick = (e) => { if (e.target.id === 'modal-mask') closeModal(); };
$('#assignee-select').onchange = updateAssigneeNote;
$('#dispatch-form').onsubmit = submitDispatch;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal-mask').hidden) closeModal(); });
window.addEventListener('resize', () => requestAnimationFrame(drawConnectors));

(async function init() {
  try {
    await loadWorkspaces();
    await loadOverview();
  } catch (err) {
    toast('初始化失败', { error: true, detail: err.message });
    $('#org-chart').innerHTML = `<div class="empty">${esc(err.message)}<br/>请确认已安装并登录 multica CLI（multica workspace list 可用）。</div>`;
  }
  setInterval(() => {
    if (!document.hidden && $('#modal-mask').hidden && state.overview) loadOverview().catch(() => {});
  }, 60000);
})();
