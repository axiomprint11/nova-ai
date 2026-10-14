// Designer AI — AutoAssign Jobs (1.20.14). The other two tabs are placeholders.
(function () {
  'use strict';
  const token = localStorage.getItem('axiom_token');
  if (!token) { location.href = '/'; return; }
  const H = () => ({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = (id) => document.getElementById(id);
  const api = async (url, body) => {
    const r = await fetch(url, body ? { method: 'POST', headers: H(), body: JSON.stringify(body) } : { headers: H() });
    if (r.status === 401 || r.status === 403) { location.href = '/'; throw new Error('signed out'); }
    const j = await r.json().catch(() => ({})); if (!r.ok && !j.error) j.error = 'Error ' + r.status; return j;
  };
  const toast = (m) => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); };
  const usD = (d) => { if (!d) return ''; const x = new Date(String(d).replace(' ', 'T')); return isNaN(x) ? String(d).slice(0, 10) : (x.getMonth() + 1 + '').padStart(2, '0') + '-' + (x.getDate() + '').padStart(2, '0') + '-' + x.getFullYear(); };
  const ago = (d) => { if (!d) return ''; const ms = Date.now() - new Date(String(d).replace(' ', 'T')).getTime(); const h = Math.round(ms / 36e5); if (h < 1) return 'just now'; if (h < 24) return h + ' h ago'; const dd = Math.round(h / 24); return dd + ' day' + (dd === 1 ? '' : 's') + ' ago'; };
  const av = (d, cls) => d.photo ? '<img class="da-av ' + (cls || '') + '" src="' + esc(d.photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;da-av ' + (cls || '') + '&quot;>' + esc((d.name || '?').charAt(0)) + '</span>\'">' : '<span class="da-av ' + (cls || '') + '">' + esc((d.name || '?').charAt(0)) + '</span>';

  // tabs
  document.querySelectorAll('.da-tabs button').forEach(b => b.onclick = () => { document.querySelectorAll('.da-tabs button').forEach(x => x.classList.toggle('on', x === b)); document.querySelectorAll('.da-view').forEach(v => v.classList.toggle('on', v.dataset.v === b.dataset.v)); });

  // ---- designers
  let team = [];
  async function loadTeam() {
    const j = await api('/api/designer/designers'); if (!j.ok) { $('daTeam').innerHTML = '<div class="da-muted">' + esc(j.error) + '</div>'; return; }
    team = j.designers; $('daTeamN').textContent = team.filter(d => d.active).length + ' active';
    $('daTeam').innerHTML = team.map(d => '<div class="da-d' + (d.active ? '' : ' off') + '" data-d="' + d.user_id + '">' + av(d) + '<div style="min-width:0;flex:1"><b>' + esc(d.name + ' ' + (d.last_name || '')) + '</b><div class="t">' + esc(d.title || 'Designer') + '</div>' +
      '<div class="load"><b>' + d.active_jobs + '</b> active · ' + d.done_30 + ' approved in 30 d' + (d.nova_assigned ? ' · ' + d.nova_assigned + ' picked here' : '') + (d.max_active ? ' · max ' + d.max_active : '') + '</div>' +
      '<div class="da-sk">' + (d.tier2 ? '<span class="t2">Tier 2</span>' : '') + d.skill_list.map(s => '<span>' + esc(s) + '</span>').join('') + (!d.skill_list.length && !d.tier2 ? '<span style="background:#fff7ed;color:#c2410c">no strong sides yet</span>' : '') + '</div><div class="da-formslot"></div></div>' +
      '<button class="edit" data-edit="' + d.user_id + '">Edit</button></div>').join('');
    $('daTeam').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editDesigner(Number(b.dataset.edit)));
  }
  function editDesigner(id) {
    const d = team.find(x => x.user_id === id); const card = $('daTeam').querySelector('[data-d="' + id + '"] .da-formslot'); if (!d || !card) return;
    if (card.innerHTML) { card.innerHTML = ''; return; }
    card.innerHTML = '<div class="da-form"><label>Strong sides — comma separated, matched against the product, its category and the proof type (e.g. packaging, die cut, large format, business cards, labels, booklets, vehicle wrap)</label><textarea rows="2" class="sk">' + esc(d.skills) + '</textarea>' +
      '<div class="row"><label><input type="checkbox" class="t2"' + (d.tier2 ? ' checked' : '') + '> Tier 2 designer</label><label>max active <input type="number" class="mx" min="1" value="' + (d.max_active || 25) + '"></label><label><input type="checkbox" class="ac"' + (d.active ? ' checked' : '') + '> takes jobs</label></div>' +
      '<label>Notes</label><input class="nt" value="' + esc(d.notes || '') + '">' +
      '<div class="row"><button class="bk-btn pri sm sv">Save</button><button class="bk-btn sm cx">Cancel</button></div></div>';
    card.querySelector('.cx').onclick = () => { card.innerHTML = ''; };
    card.querySelector('.sv').onclick = async () => { const r = await api('/api/designer/designers/' + id, { skills: card.querySelector('.sk').value, tier2: card.querySelector('.t2').checked, max_active: card.querySelector('.mx').value, active: card.querySelector('.ac').checked, notes: card.querySelector('.nt').value }); if (!r.ok) { alert(r.error); return; } toast('Saved'); loadTeam(); };
  }

  // ---- queue
  let tier = 1, jobs = [];
  const proofTag = (j) => { const p = (j.proof_type || '').toLowerCase(); const cls = /insta/.test(p) ? 'insta' : /tier ?2/.test(p) ? 't2' : 't1'; return '<span class="da-tag ' + cls + '">' + esc(j.proof_type || (j.tier === 2 ? 'Tier 2' : 'Tier 1')) + '</span>'; };
  async function loadQueue() {
    $('daQueue').innerHTML = '<div class="da-muted">Reading the CRM…</div>';
    const j = await api('/api/designer/queue?tier=' + tier + ($('daAll').checked ? '&all=1' : ''));
    if (!j.ok) { $('daQueue').innerHTML = '<div class="da-empty" style="color:#b91c1c">' + esc(j.error) + '</div>'; return; }
    jobs = j.jobs; $('daQueueN').textContent = jobs.length + ' job' + (jobs.length === 1 ? '' : 's'); $(tier === 1 ? 'daT1' : 'daT2').textContent = jobs.length;
    if (!jobs.length) { $('daQueue').innerHTML = '<div class="da-empty">Nothing is parked on the Tier ' + tier + ' placeholder right now' + ($('daAll').checked ? '' : ' (invoiced jobs only — tick "include quotes" to see the rest)') + '.</div>'; return; }
    $('daQueue').innerHTML = '<table class="da"><thead><tr><th>Job</th><th>Product</th><th>Created</th><th>Proof type</th><th>Status</th><th>Team on it</th><th style="width:360px">Designer</th></tr></thead><tbody>' + jobs.map(row).join('') + '</tbody></table>';
    bind();
  }
  const row = (j) => '<tr data-job="' + j.id + '"><td><span class="da-e">' + esc(j.e) + '</span>' + (j.invoiced ? '' : ' <span class="da-tag quote">quote</span>') + '<div class="da-sub">' + esc(j.name || '') + '</div><div class="da-sub">' + esc(j.customer) + '</div></td>' +
    '<td>' + (j.product_image ? '<img class="da-pimg" src="' + esc(j.product_image) + '" alt="" onerror="this.remove()">' : '') + '<b>' + esc(j.product) + '</b><div class="da-sub">' + esc(j.category) + (j.files_type ? ' · ' + esc(j.files_type) : '') + (j.service === 'expedite' ? ' · <b style="color:#b91c1c">expedite</b>' : '') + '</div></td>' +
    '<td>' + esc(usD(j.created)) + '<div class="da-sub">' + esc(ago(j.created)) + (j.complete_by ? '<br>due ' + esc(usD(j.complete_by)) : '') + '</div></td>' +
    '<td>' + proofTag(j) + '</td><td><span class="da-tag st">' + esc(j.status_label) + '</span><div class="da-sub">' + esc(j.substage || '') + '</div></td>' +
    '<td class="da-sub">' + esc(j.others || '—') + '</td>' +
    '<td class="da-dcell">' + dcell(j) + '</td></tr>';
  const dcell = (j) => {
    const ids = j.designer_ids || [];
    if (j.nova) { const d = team.find(x => x.user_id === j.nova.user_id); return '<div class="da-assigned">' + (d ? av(d) : '') + '<div><b>' + esc(d ? d.name : 'designer #' + j.nova.user_id) + '</b> <span class="da-sub">picked in Nova ' + esc(ago(j.nova.at)) + (j.nova.score ? ' · ' + j.nova.score + '%' : '') + '</span><div class="da-sub">' + esc(j.nova.reason || '') + ' · not in the CRM yet</div></div><a href="#" data-unassign="' + j.id + '">clear</a></div>'; }
    if (ids.length) { return '<div class="da-assigned">' + ids.map(id => { const d = team.find(x => x.user_id === id); return d ? av(d) + '<b>' + esc(d.name) + '</b>' : ''; }).join(' ') + '<span class="da-sub">already on it in the CRM</span></div> <button class="bk-btn sm" data-match="' + j.id + '">Match anyway</button>'; }
    return '<button class="bk-btn pri sm" data-match="' + j.id + '">Match</button> <span class="da-sub">who should take it</span>';
  };
  function bind() {
    $('daQueue').querySelectorAll('[data-match]').forEach(b => b.onclick = () => runMatch(Number(b.dataset.match), b));
    $('daQueue').querySelectorAll('[data-unassign]').forEach(a => a.onclick = async (e) => { e.preventDefault(); await api('/api/designer/unassign', { estimate_id: Number(a.dataset.unassign) }); loadQueue(); loadTeam(); });
  }
  async function runMatch(id, btn) {
    const td = btn.closest('td'); td.innerHTML = '<span class="da-muted">Thinking…</span>';
    const r = await api('/api/designer/match', { estimate_id: id, tier });
    if (!r.ok) { td.innerHTML = '<span style="color:#b91c1c;font-size:12px">' + esc(r.error) + '</span>'; return; }
    td.innerHTML = '<div class="da-picks">' + r.picks.map((p, i) => '<div class="da-pick' + (i === 0 ? ' top' : '') + '">' + av(p) + '<span class="pct">' + p.score + '%</span><div class="who"><b>' + esc(p.name + ' ' + (p.last_name || '')) + '</b><div class="why">' + esc(p.why.join(' · ')) + '</div></div><button class="bk-btn sm ' + (i === 0 ? 'go' : '') + '" data-pick="' + p.user_id + '" data-score="' + p.score + '" data-why="' + esc(p.why.join(' · ')) + '">Assign</button></div>').join('') + '<a href="#" class="da-sub" data-close="1">close</a></div>';
    td.querySelectorAll('[data-pick]').forEach(b => b.onclick = async () => { const x = await api('/api/designer/assign', { estimate_id: id, user_id: Number(b.dataset.pick), score: Number(b.dataset.score), reason: b.dataset.why }); if (!x.ok) { alert(x.error); return; } toast('E' + id + ' → ' + x.designer.name + ' (kept in Nova; the CRM is not changed yet)'); loadQueue(); loadTeam(); });
    const c = td.querySelector('[data-close]'); if (c) c.onclick = (e) => { e.preventDefault(); const j = jobs.find(x => x.id === id); td.innerHTML = dcell(j); bind(); };
  }
  document.querySelectorAll('.da-chips [data-tier]').forEach(b => b.onclick = () => { tier = Number(b.dataset.tier); document.querySelectorAll('.da-chips [data-tier]').forEach(x => x.classList.toggle('on', x === b)); loadQueue(); });
  $('daAll').onchange = loadQueue; $('daRefresh').onclick = () => { loadQueue(); loadTeam(); };

  (async () => { await loadTeam(); await loadQueue(); try { const other = await api('/api/designer/queue?tier=2'); if (other.ok) $('daT2').textContent = other.jobs.length; } catch (e) {} })();
})();
