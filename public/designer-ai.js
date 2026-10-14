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
    $('daTeam').innerHTML = '<table class="da-tt"><thead><tr><th>Designer</th><th>Active jobs</th><th>Waiting on client</th><th>Approved · 30 d</th><th>Picked here</th><th>Tier 2</th><th>Hard jobs</th><th>Creative</th><th>Hours</th><th>Max active</th><th>Strong sides</th><th>Notes</th><th></th></tr></thead><tbody>' +
      team.map(d => '<tr data-d="' + d.user_id + '"' + (d.active ? '' : ' class="off"') + '><td><div class="da-who">' + av(d) + '<div><b>' + esc(d.name + ' ' + (d.last_name || '')) + '</b><div class="t">' + esc(d.title || 'Designer') + (d.active ? '' : ' · not taking jobs') + '</div></div></div></td>' +
        '<td><span class="da-num" title="Proof Checking / edits on the desk — what the CRM board counts">' + d.active_jobs + '</span></td><td><span class="da-num" title="Proof Sent / waiting for files">' + d.waiting_client + '</span></td><td><span class="da-num">' + d.done_30 + '</span></td><td><span class="da-num">' + (d.nova_assigned || 0) + '</span></td>' +
        '<td>' + (d.tier2 ? '<span class="da-sk"><span class="t2">Tier 2</span></span>' : '<span class="da-muted">—</span>') + '</td>' +
        '<td>' + lvl(d.hard_level, '#b45309') + '</td><td>' + lvl(d.creative_level, '#7c3aed') + '</td>' +
        '<td>' + (d.shift_start && d.shift_end ? '<span class="' + (d.on_shift && d.on_shift.on ? 'da-on' : 'da-off') + '">' + esc(fmtT(d.shift_start) + '–' + fmtT(d.shift_end)) + '</span><div class="da-muted" style="font-size:10.5px">' + esc(d.on_shift && d.on_shift.known ? (d.on_shift.on ? 'on shift · ' + d.on_shift.left + ' min left' : d.on_shift.why) : '') + (d.is_new ? ' · newer (' + d.jobs_180 + ' jobs/180 d)' : '') + '</div>' : '<span class="da-muted">not set</span>' + (d.is_new ? '<div class="da-muted" style="font-size:10.5px">newer (' + d.jobs_180 + ' jobs/180 d)</div>' : '')) + '</td>' +
        '<td>' + (d.max_active || 25) + '</td>' +
        '<td><div class="da-sk">' + (d.skill_list.length ? d.skill_list.map(s => '<span>' + esc(s) + '</span>').join('') : '<span style="background:#fff7ed;color:#c2410c">none yet</span>') + '</div></td>' +
        '<td class="da-muted" style="max-width:220px">' + esc(d.notes || '') + '</td><td><button class="bk-btn sm" data-edit="' + d.user_id + '">Edit</button></td></tr>').join('') + '</tbody></table>';
    $('daTeam').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editDesigner(Number(b.dataset.edit)));
  }
  const lvl = (n, color) => { n = n == null ? 5 : n; return '<span class="da-lvl" title="' + n + ' of 10"><i style="width:' + (n * 10) + '%;background:' + color + '"></i></span> <b>' + n + '</b>'; };
  const fmtT = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); if (!m) return ''; const h = Number(m[1]), mm = m[2]; return (h % 12 || 12) + (mm !== '00' ? ':' + mm : '') + (h < 12 ? 'am' : 'pm'); };
  function editDesigner(id) {
    const d = team.find(x => x.user_id === id); const tr = $('daTeam').querySelector('tr[data-d="' + id + '"]'); if (!d || !tr) return;
    const old = tr.nextElementSibling; if (old && old.classList.contains('da-formrow')) { old.remove(); return; }
    const fr = document.createElement('tr'); fr.className = 'da-formrow';
    fr.innerHTML = '<td colspan="13"><div class="da-form" style="max-width:760px"><label>Strong sides — comma separated; matched against the product, its category, the proof type and the job name (e.g. packaging, die cut, large format, business cards, labels, booklets, vehicle wrap, variable data)</label><textarea rows="2" class="sk">' + esc(d.skills) + '</textarea>' +
      '<div class="row"><label><input type="checkbox" class="t2"' + (d.tier2 ? ' checked' : '') + '> Tier 2 designer</label><label>max active <input type="number" class="mx" min="1" value="' + (d.max_active || 25) + '"></label><label><input type="checkbox" class="ac"' + (d.active ? ' checked' : '') + '> takes jobs</label></div>' +
      '<div class="row"><label title="0 = only the simplest jobs · 10 = packaging, die cuts, wraps, anything">Hard jobs <input type="range" class="hl" min="0" max="10" value="' + (d.hard_level == null ? 5 : d.hard_level) + '" oninput="this.nextElementSibling.textContent=this.value"><b>' + (d.hard_level == null ? 5 : d.hard_level) + '</b>/10</label>' +
      '<label title="0 = production only · 10 = designs from scratch, branding, layouts">Creative jobs <input type="range" class="cl" min="0" max="10" value="' + (d.creative_level == null ? 5 : d.creative_level) + '" oninput="this.nextElementSibling.textContent=this.value"><b>' + (d.creative_level == null ? 5 : d.creative_level) + '</b>/10</label></div>' +
      '<div class="row"><label>Hours (LA) <input type="time" class="ss" value="' + esc(d.shift_start || '') + '"> to <input type="time" class="se" value="' + esc(d.shift_end || '') + '"></label><label>Days ' + [1, 2, 3, 4, 5, 6, 7].map(n => '<label style="margin:0 2px"><input type="checkbox" class="wd" value="' + n + '"' + ((d.work_days || '1,2,3,4,5').split(',').map(Number).indexOf(n) > -1 ? ' checked' : '') + '>' + ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][n - 1] + '</label>').join('') + '</label><span class="da-muted">A job is never suggested off shift, and not within the last hour of the day (soon from the hours table).</span></div>' +
      '<label>Notes</label><input class="nt" value="' + esc(d.notes || '') + '">' +
      '<div class="row"><button class="bk-btn pri sm sv">Save</button><button class="bk-btn sm cx">Cancel</button></div></div></td>';
    tr.after(fr);
    fr.querySelector('.cx').onclick = () => fr.remove();
    fr.querySelector('.sv').onclick = async () => { const r = await api('/api/designer/designers/' + id, { skills: fr.querySelector('.sk').value, tier2: fr.querySelector('.t2').checked, max_active: fr.querySelector('.mx').value, active: fr.querySelector('.ac').checked, notes: fr.querySelector('.nt').value,
      hard_level: fr.querySelector('.hl').value, creative_level: fr.querySelector('.cl').value, shift_start: fr.querySelector('.ss').value, shift_end: fr.querySelector('.se').value, work_days: Array.from(fr.querySelectorAll('.wd:checked')).map(x => x.value).join(',') }); if (!r.ok) { alert(r.error); return; } toast('Saved'); loadTeam(); };
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
    '<td>' + (j.product_image ? '<img class="da-pimg" src="' + esc(j.product_image) + '" alt="" onerror="this.remove()">' : '') + '<b>' + esc(j.product) + '</b><div class="da-sub">' + esc(j.category) + (j.files_type ? ' · ' + esc(j.files_type) : '') + (j.service === 'expedite' ? ' · <b style="color:#b91c1c">expedite</b>' : '') + '</div>' +
      '<div class="da-sub da-jl"><span title="How hard Nova rates this job, 0–10 (category, die cut / wrap / variable data, Tier 2, expedite)">hard <b>' + j.hard + '</b></span> · <span title="How creative, 0–10 (design fee, Work with Our Designers, design notes)">creative <b>' + j.creative + '</b></span>' + (j.design_fee ? ' · <b style="color:#7c3aed">$' + j.design_fee + ' design</b>' : '') + (j.common ? ' · common product' : '') + (j.notes ? ' · <a href="#" class="da-notes" data-notes="' + esc(j.notes) + '">notes</a>' : '') + '</div></td>' +
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
    $('daQueue').querySelectorAll('[data-notes]').forEach(a => a.onclick = (e) => { e.preventDefault(); let p = a.nextElementSibling; if (p && p.classList.contains('da-notebox')) { p.remove(); return; } p = document.createElement('pre'); p.className = 'da-notebox'; p.textContent = a.dataset.notes; a.after(p); });
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
