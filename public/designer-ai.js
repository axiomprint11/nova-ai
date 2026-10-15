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
    $('daTeam').innerHTML = '<table class="da-tt"><thead><tr><th class="da-c-who">Designer</th><th>Active</th><th>Waiting</th><th>Approved</th><th>Assigned</th><th>Tier 2</th><th>Hard jobs</th><th>Creative</th><th>Client comm.</th><th>Hours</th><th>Max active</th><th>Strong sides</th><th>Notes</th><th></th></tr></thead><tbody>' +
      team.map(d => '<tr data-d="' + d.user_id + '"' + (d.active ? '' : ' class="off"') + '><td><div class="da-who">' + av(d) + '<div><b>' + esc(d.name + ' ' + (d.last_name || '')) + '</b><div class="t" title="' + esc(d.title || 'Designer') + '">' + esc(shortTitle(d.title || 'Designer')) + (d.active ? '' : ' · not taking jobs') + '</div></div></div></td>' +
        '<td><span class="da-num" title="Proof Checking / edits on the desk — what the CRM board counts">' + d.active_jobs + '</span></td><td><span class="da-num" title="Proof Sent / waiting for files">' + d.waiting_client + '</span></td><td class="da-appr"><span><b class="da-num">' + d.done_30 + '</b><i>30 d</i></span><span class="da-muted">/</span><span><b class="da-num">' + (d.done_90 || 0) + '</b><i>90 d</i></span></td><td><span class="da-num">' + (d.nova_assigned || 0) + '</span></td>' +
        '<td><input type="checkbox" class="da-t2" data-t2="' + d.user_id + '"' + (d.tier2 ? ' checked' : '') + ' title="Tier 2 designer"></td>' +
        '<td>' + lvl(d.hard_level, '#b45309') + '</td><td>' + lvl(d.creative_level, '#7c3aed') + '</td><td>' + lvl(d.comm_level, '#0e7490') + ((d.language_list || []).length ? '<div class="da-flags">' + d.language_list.map(lflag).join('') + '</div>' : '') + '</td>' +
        '<td>' + (d.shift_start && d.shift_end ? '<span class="' + (d.on_shift && d.on_shift.on ? 'da-on' : 'da-off') + '">' + esc(fmtT(d.shift_start) + '–' + fmtT(d.shift_end)) + '</span><div class="da-muted" style="font-size:10.5px">' + esc(d.on_shift && d.on_shift.known ? (d.on_shift.on ? 'on shift · ' + d.on_shift.left + ' min left' : d.on_shift.why) : '') + (d.is_new ? ' · newer (' + d.jobs_180 + ' jobs/180 d)' : '') + '</div>' : '<span class="da-muted">not set</span>' + (d.is_new ? '<div class="da-muted" style="font-size:10.5px">newer (' + d.jobs_180 + ' jobs/180 d)</div>' : '')) + '</td>' +
        '<td>' + (d.max_active || 25) + '</td>' +
        '<td class="da-skc" title="' + esc(d.skill_list.join(', ')) + '"><div class="da-sk">' + (d.skill_list.length ? d.skill_list.map(s => '<span>' + esc(s) + '</span>').join('') : '<span style="background:#fff7ed;color:#c2410c">none yet</span>') + '</div></td>' +
        '<td class="da-muted da-notes" title="' + esc(d.notes || '') + '">' + esc(d.notes || '') + '</td><td class="da-edit"><button class="bk-btn sm" data-edit="' + d.user_id + '">Edit</button></td></tr>').join('') + '</tbody></table>';
    $('daTeam').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editDesigner(Number(b.dataset.edit)));
    $('daTeam').querySelectorAll('[data-t2]').forEach(c => c.onchange = async () => { const r = await api('/api/designer/designers/' + c.dataset.t2, { tier2: c.checked }); if (!r.ok) { alert(r.error); c.checked = !c.checked; return; } const d = team.find(x => x.user_id === Number(c.dataset.t2)); if (d) d.tier2 = c.checked ? 1 : 0; toast(c.checked ? 'Tier 2 on' : 'Tier 2 off'); });
  }
  // long CRM titles are shortened in the table ("Prepress Technician / Graphic Designer" → "Prepress Tech. / Graphic Des."), full on hover
  const shortTitle = (t) => { let x = String(t).replace(/Technician/g, 'Tech.').replace(/Specialist/g, 'Spec.').replace(/Designer/g, 'Des.'); return x.length > 26 ? x.slice(0, 25).replace(/[\s\/]+$/, '') + '…' : x; };
  const LANGS = ['English', 'Armenian', 'Russian', 'Spanish', 'Filipino', 'Mandarin'];
  // 1.20.29: a flag per language (inline SVG, 18×12) — the US for English, Mexico for Spanish
  const LFLAG = {
    English: '<svg viewBox="0 0 18 12"><rect width="18" height="12" fill="#b22234"/><g fill="#fff"><rect y="1.85" width="18" height="1.85"/><rect y="5.54" width="18" height="1.85"/><rect y="9.23" width="18" height="1.85"/></g><rect width="7.6" height="6.46" fill="#3c3b6e"/></svg>',
    Armenian: '<svg viewBox="0 0 18 12"><rect width="18" height="4" fill="#d90012"/><rect y="4" width="18" height="4" fill="#0033a0"/><rect y="8" width="18" height="4" fill="#f2a800"/></svg>',
    Russian: '<svg viewBox="0 0 18 12"><rect width="18" height="4" fill="#fff"/><rect y="4" width="18" height="4" fill="#0039a6"/><rect y="8" width="18" height="4" fill="#d52b1e"/></svg>',
    Spanish: '<svg viewBox="0 0 18 12"><rect width="6" height="12" fill="#006847"/><rect x="6" width="6" height="12" fill="#fff"/><rect x="12" width="6" height="12" fill="#ce1126"/><circle cx="9" cy="6" r="1.6" fill="#8a6a2b"/></svg>',
    Filipino: '<svg viewBox="0 0 18 12"><rect width="18" height="6" fill="#0038a8"/><rect y="6" width="18" height="6" fill="#ce1126"/><path d="M0 0l8 6-8 6z" fill="#fff"/><circle cx="2.6" cy="6" r="1.1" fill="#fcd116"/></svg>',
    Mandarin: '<svg viewBox="0 0 18 12"><rect width="18" height="12" fill="#de2910"/><path d="M3 2.2l.7 2.1h2.2L4.1 5.6l.7 2.1L3 6.4 1.2 7.7l.7-2.1L.1 4.3h2.2z" fill="#ffde00"/></svg>'
  };
  const lflag = (l) => '<span class="da-flag" title="' + esc(l) + '">' + (LFLAG[l] || '') + '</span>';
  const lvl = (n, color) => { n = n == null ? 5 : n; return '<span class="da-lvl" title="' + n + ' of 10"><i style="width:' + (n * 10) + '%;background:' + color + '"></i></span> <b>' + n + '</b>'; };
  const fmtT = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); if (!m) return ''; const h = Number(m[1]), mm = m[2]; return (h % 12 || 12) + (mm !== '00' ? ':' + mm : '') + (h < 12 ? 'am' : 'pm'); };
  function editDesigner(id) {
    const d = team.find(x => x.user_id === id); const tr = $('daTeam').querySelector('tr[data-d="' + id + '"]'); if (!d || !tr) return;
    const old = tr.nextElementSibling; if (old && old.classList.contains('da-formrow')) { old.remove(); return; }
    const fr = document.createElement('tr'); fr.className = 'da-formrow';
    const L = (n) => n == null ? 5 : n, days = (d.work_days || '1,2,3,4,5').split(',').map(Number), langs = d.language_list || [];
    fr.innerHTML = '<td colspan="14"><div class="da-ef">' +
      '<div class="da-ef-main"><label class="da-ef-l">Strong sides <span class="da-q" tabindex="0">?<span class="da-tip">Comma separated. Matched against the product, its category, the proof type and the job name — e.g. packaging, die cut, large format, business cards, labels, booklets, vehicle wrap, variable data.</span></span></label><textarea rows="3" class="sk" placeholder="packaging, die cut, large format…">' + esc(d.skills) + '</textarea>' +
        '<label class="da-ef-l" style="margin-top:14px">Notes</label><input class="nt" value="' + esc(d.notes || '') + '" placeholder="Anything the matcher should know about ' + esc(d.name) + '"></div>' +
      '<div class="da-ef-side">' +
        '<div class="da-ef-top">' +
          '<label><input type="checkbox" class="t2"' + (d.tier2 ? ' checked' : '') + '> Tier 2 designer</label>' +
          '<label><input type="checkbox" class="ac"' + (d.active ? ' checked' : '') + '> Takes jobs</label>' +
          '<label>Max active <input type="number" class="mx" min="1" value="' + (d.max_active || 25) + '"></label>' +
        '</div>' +
        '<div class="da-ef-three">' +
          '<div class="da-ef-row da-ef-sl"><label>Hard jobs <b>' + L(d.hard_level) + '</b>/10 <span class="da-q" tabindex="0">?<span class="da-tip">0 = the simplest jobs only · 10 = packaging, die cuts, wraps, anything.</span></span></label><input type="range" class="hl" min="0" max="10" value="' + L(d.hard_level) + '" oninput="this.previousElementSibling.querySelector(\'b\').textContent=this.value"></div>' +
          '<div class="da-ef-row da-ef-sl"><label>Creative jobs <b>' + L(d.creative_level) + '</b>/10 <span class="da-q" tabindex="0">?<span class="da-tip">0 = production only · 10 = designs from scratch, branding, layouts.</span></span></label><input type="range" class="cl" min="0" max="10" value="' + L(d.creative_level) + '" oninput="this.previousElementSibling.querySelector(\'b\').textContent=this.value"></div>' +
          '<div class="da-ef-row da-ef-sl"><label>Client communication <b>' + L(d.comm_level) + '</b>/10 <span class="da-q" tabindex="0">?<span class="da-tip">0 = keep away from the client · 10 = runs the back-and-forth on design jobs by themselves.</span></span></label><input type="range" class="cm" min="0" max="10" value="' + L(d.comm_level) + '" oninput="this.previousElementSibling.querySelector(\'b\').textContent=this.value"></div>' +
        '</div>' +
        '<div class="da-ef-row"><label>Languages</label><div class="da-ef-days da-ef-langs">' + LANGS.map(l => '<label><input type="checkbox" class="lg" value="' + l + '"' + (langs.indexOf(l) > -1 ? ' checked' : '') + '>' + lflag(l) + l + '</label>').join('') + '</div></div>' +
        '<div class="da-ef-row"><label>Hours (LA)</label><div class="da-ef-hours"><div class="da-ef-days">' + [1, 2, 3, 4, 5, 6, 7].map(n => '<label><input type="checkbox" class="wd" value="' + n + '"' + (days.indexOf(n) > -1 ? ' checked' : '') + '>' + ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][n - 1] + '</label>').join('') + '</div><div class="da-ef-time"><input type="time" class="ss" value="' + esc(d.shift_start || '') + '"> <span>to</span> <input type="time" class="se" value="' + esc(d.shift_end || '') + '"></div></div></div>' +
      '</div>' +
      '</div>' +
      '<div class="da-ef-foot"><button class="bk-btn pri sv">Save</button><button class="bk-btn cx">Cancel</button></div></div></td>';
    tr.after(fr);
    fr.querySelector('.cx').onclick = () => fr.remove();
    fr.querySelector('.sv').onclick = async () => { const r = await api('/api/designer/designers/' + id, { skills: fr.querySelector('.sk').value, tier2: fr.querySelector('.t2').checked, max_active: fr.querySelector('.mx').value, active: fr.querySelector('.ac').checked, notes: fr.querySelector('.nt').value,
      hard_level: fr.querySelector('.hl').value, creative_level: fr.querySelector('.cl').value, shift_start: fr.querySelector('.ss').value, shift_end: fr.querySelector('.se').value, work_days: Array.from(fr.querySelectorAll('.wd:checked')).map(x => x.value).join(','), comm_level: fr.querySelector('.cm').value, languages: Array.from(fr.querySelectorAll('.lg:checked')).map(x => x.value).join(',') }); if (!r.ok) { alert(r.error); return; } toast('Saved'); loadTeam(); };
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
    '<td><div class="da-others">' + ((j.team || []).length ? j.team.map(t => '<span class="da-face" title="' + esc((t.name + ' ' + (t.last_name || '')).trim()) + '">' + av(t) + '</span>').join('') : '<span class="da-sub">—</span>') + '</div></td>' +
    '<td class="da-dcell">' + dcell(j) + '</td></tr>';
  const dcell = (j) => {
    const ids = j.designer_ids || [];
    if (j.nova) { const d = team.find(x => x.user_id === j.nova.user_id); return '<div class="da-assigned">' + (d ? av(d) : '') + '<div><b>' + esc(d ? d.name : 'designer #' + j.nova.user_id) + '</b> <span class="da-sub">picked in Nova ' + esc(ago(j.nova.at)) + (j.nova.score ? ' · ' + j.nova.score + '%' : '') + '</span><div class="da-sub">' + esc(j.nova.reason || '') + ' · not in the CRM yet</div></div><a href="#" data-unassign="' + j.id + '">clear</a></div>'; }
    if (ids.length) { return '<div class="da-assigned">' + ids.map(id => { const d = team.find(x => x.user_id === id); return d ? av(d) + '<b>' + esc(d.name) + '</b>' : ''; }).join(' ') + '<span class="da-sub">already on it in the CRM</span></div> <button class="bk-btn sm" data-match="' + j.id + '">Match anyway</button>'; }
    if (j.busy) return '<div class="da-busy"><span class="da-tag busy">Everyone is busy</span><div class="da-sub">' + esc(ago(j.busy.at)) + ' · ' + esc(j.busy.reason || '') + ' · left in the queue for the designers to pick up</div></div> <button class="bk-btn sm" data-match="' + j.id + '">Match again</button>';
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
    td.innerHTML = '<div class="da-picks">' + (r.busy ? '<div class="da-busy top"><span class="da-tag busy">Everyone is busy</span> <span class="da-sub">' + esc(r.busy.reason || '') + '</span><div class="da-sub">' + (r.busy.emailed ? 'Emailed ' + esc((r.busy.to || []).join(', ')) : r.busy.emailed_at ? 'Team already emailed ' + esc(ago(r.busy.emailed_at)) : r.busy.error ? 'Email failed: ' + esc(r.busy.error) : 'No email sent') + ' · the job stays in the queue; assign below only to override</div></div>' : '') + (r.ai ? '<div class="da-sub-ai">✦ your Match Logic was applied</div>' : r.ai_error ? '<div class="da-sub-ai" style="color:#b91c1c">Match Logic not applied: ' + esc(r.ai_error) + '</div>' : '') + r.picks.map((p, i) => '<div class="da-pick' + (i === 0 ? ' top' : '') + '">' + av(p) + '<span class="pct">' + p.score + '%</span><div class="who"><b>' + esc(p.name + ' ' + (p.last_name || '')) + '</b><div class="why">' + esc(p.why.join(' · ')) + '</div></div><button class="bk-btn sm ' + (i === 0 ? 'go' : '') + '" data-pick="' + p.user_id + '" data-score="' + p.score + '" data-why="' + esc(p.why.join(' · ')) + '">Assign</button></div>').join('') + '<a href="#" class="da-sub" data-close="1">close</a></div>';
    td.querySelectorAll('[data-pick]').forEach(b => b.onclick = async () => { const x = await api('/api/designer/assign', { estimate_id: id, user_id: Number(b.dataset.pick), score: Number(b.dataset.score), reason: b.dataset.why }); if (!x.ok) { alert(x.error); return; } toast('E' + id + ' → ' + x.designer.name + ' (kept in Nova; the CRM is not changed yet)'); loadQueue(); loadTeam(); });
    const c = td.querySelector('[data-close]'); if (c) c.onclick = (e) => { e.preventDefault(); const j = jobs.find(x => x.id === id); td.innerHTML = dcell(j); bind(); };
  }
  // ---- Match Logic (1.20.18): the owner's rules in words, read by the model on every Match
  async function loadLogic() {
    const j = await api('/api/designer/settings'); if (!j.ok) return;
    $('daOverload').value = j.overload_logic || ''; $('daOverloadTo').value = j.overload_to || ''; $('daOverloadWhen').textContent = j.overload_updated_at ? 'Saved ' + new Date(j.overload_updated_at).toLocaleString() + (j.overload_updated_by ? ' by ' + j.overload_updated_by.replace(/^(user|member):/, '') : '') : 'Nova\'s default — edit and save to make it yours.';
    $('daLogic').value = j.match_logic || ''; $('daLogicWhen').textContent = j.updated_at ? 'Saved ' + new Date(j.updated_at).toLocaleString() + (j.updated_by ? ' by ' + j.updated_by.replace(/^(user|member):/, '') : '') : 'Nothing saved yet — Nova uses only its built-in rules.';
  }
  $('daOverloadSave').onclick = async () => { const r = await api('/api/designer/settings', { overload_logic: $('daOverload').value, overload_to: $('daOverloadTo').value }); if (!r.ok) { alert(r.error); return; } toast('Overload logic saved'); loadLogic(); };
  $('daLogicSave').onclick = async () => { const r = await api('/api/designer/settings', { match_logic: $('daLogic').value }); if (!r.ok) { alert(r.error); return; } toast('Match logic saved'); loadLogic(); };
  document.querySelectorAll('.da-sub [data-s]').forEach(b => b.onclick = () => { document.querySelectorAll('.da-sub [data-s]').forEach(x => x.classList.toggle('on', x === b)); document.querySelectorAll('.da-subview').forEach(v => v.classList.toggle('on', v.dataset.s === b.dataset.s)); $('daAllWrap').style.visibility = b.dataset.s === 'jobs' ? '' : 'hidden'; });
  $('daAll').onchange = loadQueue; $('daRefresh').onclick = () => { loadQueue(); loadTeam(); };

  (async () => { await loadTeam(); await loadQueue(); loadLogic(); })();
})();
