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

  // ---- designers (a table, 1.20.15)
  let team = [];
  async function loadTeam() {
    const j = await api('/api/designer/designers'); if (!j.ok) { $('daTeam').innerHTML = '<div class="da-muted">' + esc(j.error) + '</div>'; return; }
    team = j.designers; $('daTeamN').textContent = team.filter(d => d.active).length;
    $('daTeam').innerHTML = '<table class="da-tt"><thead><tr><th>Designer</th><th>Active jobs</th><th>Approved · 30 d</th><th>Picked here</th><th>Tier 2</th><th>Max active</th><th>Strong sides</th><th>Notes</th><th></th></tr></thead><tbody>' +
      team.map(d => '<tr data-d="' + d.user_id + '"' + (d.active ? '' : ' class="off"') + '><td><div class="da-who">' + av(d) + '<div><b>' + esc(d.name + ' ' + (d.last_name || '')) + '</b><div class="t">' + esc(d.title || 'Designer') + (d.active ? '' : ' · not taking jobs') + '</div></div></div></td>' +
        '<td><span class="da-num">' + d.active_jobs + '</span></td><td><span class="da-num">' + d.done_30 + '</span></td><td><span class="da-num">' + (d.nova_assigned || 0) + '</span></td>' +
        '<td>' + (d.tier2 ? '<span class="da-sk"><span class="t2">Tier 2</span></span>' : '<span class="da-muted">—</span>') + '</td><td>' + (d.max_active || 25) + '</td>' +
        '<td><div class="da-sk">' + (d.skill_list.length ? d.skill_list.map(s => '<span>' + esc(s) + '</span>').join('') : '<span style="background:#fff7ed;color:#c2410c">none yet</span>') + '</div></td>' +
        '<td class="da-muted" style="max-width:220px">' + esc(d.notes || '') + '</td><td><button class="bk-btn sm" data-edit="' + d.user_id + '">Edit</button></td></tr>').join('') + '</tbody></table>';
    $('daTeam').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editDesigner(Number(b.dataset.edit)));
  }
  function editDesigner(id) {
    const d = team.find(x => x.user_id === id); const tr = $('daTeam').querySelector('tr[data-d="' + id + '"]'); if (!d || !tr) return;
    const old = tr.nextElementSibling; if (old && old.classList.contains('da-formrow')) { old.remove(); return; }
    const fr = document.createElement('tr'); fr.className = 'da-formrow';
    fr.innerHTML = '<td colspan="9"><div class="da-form" style="max-width:760px"><label>Strong sides — comma separated; matched against the product, its category, the proof type and the job name (e.g. packaging, die cut, large format, business cards, labels, booklets, vehicle wrap, variable data)</label><textarea rows="2" class="sk">' + esc(d.skills) + '</textarea>' +
      '<div class="row"><label><input type="checkbox" class="t2"' + (d.tier2 ? ' checked' : '') + '> Tier 2 designer</label><label>max active <input type="number" class="mx" min="1" value="' + (d.max_active || 25) + '"></label><label><input type="checkbox" class="ac"' + (d.active ? ' checked' : '') + '> takes jobs</label></div>' +
      '<label>Notes</label><input class="nt" value="' + esc(d.notes || '') + '">' +
      '<div class="row"><button class="bk-btn pri sm sv">Save</button><button class="bk-btn sm cx">Cancel</button></div></div></td>';
    tr.after(fr);
    fr.querySelector('.cx').onclick = () => fr.remove();
    fr.querySelector('.sv').onclick = async () => { const r = await api('/api/designer/designers/' + id, { skills: fr.querySelector('.sk').value, tier2: fr.querySelector('.t2').checked, max_active: fr.querySelector('.mx').value, active: fr.querySelector('.ac').checked, notes: fr.querySelector('.nt').value }); if (!r.ok) { alert(r.error); return; } toast('Saved'); loadTeam(); };
  }

  // ---- queue (both tiers in one table, 1.20.15)
  let jobs = [];
  const tierTag = (j) => '<span class="da-tag ' + (j.tier === 2 ? 't2' : 't1') + '">Tier ' + j.tier + '</span>';
  const proofTag = (j) => { const p = (j.proof_type || '').toLowerCase(); const cls = /insta/.test(p) ? 'insta' : /tier ?2/.test(p) ? 't2' : 't1'; return '<span class="da-tag ' + cls + '">' + esc(j.proof_type || (j.tier === 2 ? 'Tier 2' : 'Tier 1')) + '</span>'; };
  async function loadQueue() {
    $('daQueue').innerHTML = '<div class="da-muted">Reading the CRM…</div>';
    const j = await api('/api/designer/queue' + ($('daAll').checked ? '?all=1' : ''));
    if (!j.ok) { $('daQueue').innerHTML = '<div class="da-empty" style="color:#b91c1c">' + esc(j.error) + '</div>'; return; }
    jobs = j.jobs; $('daQueueN').textContent = jobs.length; $('daTierN').textContent = (j.counts ? j.counts.t1 + ' Tier 1 · ' + j.counts.t2 + ' Tier 2' : '');
    if (!jobs.length) { $('daQueue').innerHTML = '<div class="da-empty">Nothing is parked on the Tier 1 / Tier 2 placeholders right now' + ($('daAll').checked ? '' : ' (invoiced jobs only — tick "include quotes" to see the rest)') + '.</div>'; return; }
    $('daQueue').innerHTML = '<table class="da"><thead><tr><th>Job</th><th>Product</th><th>Created</th><th>Tier</th><th>Proof type</th><th>Status</th><th>Team on it</th><th style="width:360px">Designer</th></tr></thead><tbody>' + jobs.map(row).join('') + '</tbody></table>';
    bind();
  }
  const row = (j) => '<tr data-job="' + j.id + '"><td><span class="da-e">' + esc(j.e) + '</span>' + (j.invoiced ? '' : ' <span class="da-tag quote">quote</span>') + '<div class="da-sub">' + esc(j.name || '') + '</div><div class="da-sub">' + esc(j.customer) + '</div></td>' +
    '<td>' + (j.product_image ? '<img class="da-pimg" src="' + esc(j.product_image) + '" alt="" onerror="this.remove()">' : '') + '<b>' + esc(j.product) + '</b><div class="da-sub">' + esc(j.category) + (j.files_type ? ' · ' + esc(j.files_type) : '') + (j.service === 'expedite' ? ' · <b style="color:#b91c1c">expedite</b>' : '') + '</div></td>' +
    '<td>' + esc(usD(j.created)) + '<div class="da-sub">' + esc(ago(j.created)) + (j.complete_by ? '<br>due ' + esc(usD(j.complete_by)) : '') + '</div></td>' +
    '<td>' + tierTag(j) + '</td><td>' + proofTag(j) + '</td><td><span class="da-tag st">' + esc(j.status_label) + '</span><div class="da-sub">' + esc(j.substage || '') + '</div></td>' +
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
    const r = await api('/api/designer/match', { estimate_id: id });
    if (!r.ok) { td.innerHTML = '<span style="color:#b91c1c;font-size:12px">' + esc(r.error) + '</span>'; return; }
    td.innerHTML = '<div class="da-picks">' + r.picks.map((p, i) => '<div class="da-pick' + (i === 0 ? ' top' : '') + '">' + av(p) + '<span class="pct">' + p.score + '%</span><div class="who"><b>' + esc(p.name + ' ' + (p.last_name || '')) + '</b><div class="why">' + esc(p.why.join(' · ')) + '</div></div><button class="bk-btn sm ' + (i === 0 ? 'go' : '') + '" data-pick="' + p.user_id + '" data-score="' + p.score + '" data-why="' + esc(p.why.join(' · ')) + '">Assign</button></div>').join('') + '<a href="#" class="da-sub" data-close="1">close</a></div>';
    td.querySelectorAll('[data-pick]').forEach(b => b.onclick = async () => { const x = await api('/api/designer/assign', { estimate_id: id, user_id: Number(b.dataset.pick), score: Number(b.dataset.score), reason: b.dataset.why }); if (!x.ok) { alert(x.error); return; } toast('E' + id + ' → ' + x.designer.name + ' (kept in Nova; the CRM is not changed yet)'); loadQueue(); loadTeam(); });
    const c = td.querySelector('[data-close]'); if (c) c.onclick = (e) => { e.preventDefault(); const j = jobs.find(x => x.id === id); td.innerHTML = dcell(j); bind(); };
  }
  document.querySelectorAll('.da-sub [data-s]').forEach(b => b.onclick = () => { document.querySelectorAll('.da-sub [data-s]').forEach(x => x.classList.toggle('on', x === b)); document.querySelectorAll('.da-subview').forEach(v => v.classList.toggle('on', v.dataset.s === b.dataset.s)); $('daAllWrap').style.visibility = b.dataset.s === 'jobs' ? '' : 'hidden'; });
  $('daAll').onchange = loadQueue; $('daRefresh').onclick = () => { loadQueue(); loadTeam(); };

  (async () => { await loadTeam(); await loadQueue(); })();
})();
