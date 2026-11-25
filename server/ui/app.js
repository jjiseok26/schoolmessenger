'use strict';
const $ = (s) => document.querySelector(s);

// alert/confirm(네이티브 대화상자) 후 입력창 포커스가 깨지는 Electron 버그 우회
{
  const _alert = window.alert.bind(window);
  const _confirm = window.confirm.bind(window);
  window.alert = (msg) => { const r = _alert(msg); window.api?.refocus(); return r; };
  window.confirm = (msg) => { const r = _confirm(msg); window.api?.refocus(); return r; };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let onlineSet = new Set();
let lastUsers = [];

// ---------- 좌측 메뉴 ----------
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x === item));
    const sec = document.getElementById(item.dataset.target);
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// 스크롤하면 지금 보고 있는 카드의 메뉴를 강조
$('main').addEventListener('scroll', () => {
  const m = $('main');
  const items = [...document.querySelectorAll('.nav-item')];
  const top = m.getBoundingClientRect().top;
  let cur = items[0];
  for (const item of items) {
    const sec = document.getElementById(item.dataset.target);
    if (sec && sec.getBoundingClientRect().top - top <= 80) cur = item;
  }
  if (m.scrollTop + m.clientHeight >= m.scrollHeight - 4) cur = items[items.length - 1];
  items.forEach(x => x.classList.toggle('active', x === cur));
}, { passive: true });

function renderStatus(s) {
  if (!s) return;
  $('#statusBadge').textContent = s.running ? '실행 중' : '중지됨';
  $('#statusBadge').className = 'badge ' + (s.running ? 'on' : 'off');
  const addrs = (s.ips.length ? s.ips : ['127.0.0.1']).map(ip => ip + ':' + (s.port ?? '-'));
  $('#addrList').innerHTML = addrs.map(esc).join('<br>');
  if (document.activeElement !== $('#portInput')) $('#portInput').value = s.port ?? '';
  $('#userCount').textContent = s.userCount + '명';
  $('#onlineCount').textContent = s.online.length + '명';
  onlineSet = new Set(s.online);
}

// ---------- 사용자 목록 ----------
function renderUsers(users) {
  if (!users) return;
  lastUsers = users;
  // 이미 등록된 부서/학년을 고를 수 있게 제공
  $('#fDeptList').innerHTML =
    [...new Set(users.filter(u => u.id !== 'admin').flatMap(u => u.depts || [u.dept]))]
      .sort((a, b) => a.localeCompare(b, 'ko'))
      .map(d => `<option value="${esc(d)}">`).join('');
  const q = $('#userSearch').value.trim().toLowerCase();
  const tb = $('#userTable tbody');
  tb.innerHTML = '';
  for (const u of users) {
    const deptsStr = (u.depts || [u.dept]).join(', ');
    const hay = [u.id, u.name, deptsStr, u.position, u.subject, u.office, u.phone, u.mobile, u.email].join(' ').toLowerCase();
    if (q && !hay.includes(q)) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="dot ${u.online ? 'on' : 'off'}" title="${u.online ? '접속 중' : '미접속'}"></span></td>
      <td>${esc(u.id)}</td>
      <td class="td-name">${esc(u.name)}</td>
      <td>${esc(deptsStr)}</td>
      <td>${esc(u.position)}</td>
      <td class="td-sub">${esc(u.subject || '')}</td>
      <td class="td-sub">${esc(u.phone || '')}</td>
      <td><span class="role-chip ${u.admin ? 'admin' : ''}">${u.admin ? '관리자' : '일반'}</span></td>
      <td style="text-align:right">
        <button class="row-btn" data-act="edit" data-id="${esc(u.id)}" title="세부 정보·비밀번호 수정"><span class="msi">edit</span></button>
        ${u.id !== 'admin' ? `<button class="row-btn danger" data-act="del" data-id="${esc(u.id)}" title="계정 삭제"><span class="msi">delete</span></button>` : ''}
      </td>`;
    tr.addEventListener('dblclick', () => openUserModal(u));
    tb.appendChild(tr);
  }
  if (!tb.children.length) {
    tb.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#747775">${q ? '검색 결과가 없습니다' : '등록된 사용자가 없습니다'}</td></tr>`;
  }
}

async function refresh() {
  renderStatus(await window.api.getStatus());
  renderUsers(await window.api.getUsers());
}

// ---------- 계정 추가/수정 모달 (세부 정보 포함) ----------
// (Electron은 window.prompt를 지원하지 않으므로 자체 모달 사용)
const DETAIL_FIELDS = [['eSubject', 'subject'], ['eOffice', 'office'], ['ePhone', 'phone'], ['eMobile', 'mobile'], ['eEmail', 'email']];
let editingId = null; // null = 새 계정

function openUserModal(u) {
  editingId = u ? u.id : null;
  $('#editTitle').textContent = u ? `계정 수정 — ${u.name}` : '계정 추가';
  $('#eId').value = u ? u.id : '';
  $('#eId').readOnly = !!u;
  $('#ePwLabel').textContent = u ? '새 비밀번호' : '초기 비밀번호';
  $('#ePw').placeholder = u ? '비워 두면 그대로' : '비워 두면 1234';
  $('#ePw').value = '';
  $('#eName').value = u ? u.name : '';
  $('#eDept').value = u ? (u.depts || [u.dept]).join(', ') : '';
  $('#ePos').value = u ? u.position || '' : '';
  for (const [el, key] of DETAIL_FIELDS) $('#' + el).value = u ? u[key] || '' : '';
  $('#eAdmin').checked = !!(u && u.admin);
  $('#eAdmin').disabled = !!(u && u.id === 'admin'); // 기본 관리자 계정은 권한을 뺄 수 없음
  $('#editError').textContent = '';
  $('#editModal').style.display = 'flex';
  (u ? $('#eName') : $('#eId')).focus();
}

// 전화번호 자동 하이픈 — 숫자를 치는 동안 062-000-0000 형태로 (클라이언트 내 정보 수정과 같은 규칙)
//  0 이나 15~19 로 시작하지 않는 숫자(교내 내선 등)·문구가 섞인 값·자릿수가 넘치는 번호는 그대로
function formatPhone(v) {
  if (!/^[\d\s-]+$/.test(v)) return v;
  const d = v.replace(/\D/g, '');
  const join = (...parts) => parts.filter(Boolean).join('-');
  if (/^1[5-9]/.test(d)) return d.length > 8 ? v : join(d.slice(0, 4), d.slice(4)); // 대표번호
  if (!d.startsWith('0')) return v;
  const a = d.startsWith('02') ? 2 : /^0(50[2-9]|130)/.test(d) ? 4 : 3;
  if (d.length > a + 8) return v;
  if (d.length === a + 8) return join(d.slice(0, a), d.slice(a, a + 4), d.slice(a + 4));
  return join(d.slice(0, a), d.slice(a, a + 3), d.slice(a + 3));
}
for (const id of ['#ePhone', '#eMobile']) {
  const input = $(id);
  input.addEventListener('beforeinput', (e) => {
    const p = input.selectionStart;
    if (e.inputType === 'deleteContentBackward' && p === input.selectionEnd && p > 1 && input.value[p - 1] === '-') {
      input.setSelectionRange(p - 1, p - 1); // 하이픈 뒤에서 지우면 앞 숫자를 지운다
    }
  });
  input.addEventListener('input', () => {
    const v = input.value, f = formatPhone(v);
    if (f === v) return;
    const digitsBefore = v.slice(0, input.selectionStart).replace(/\D/g, '').length;
    input.value = f;
    let pos = 0, n = 0;
    while (pos < f.length && n < digitsBefore) { if (/\d/.test(f[pos])) n++; pos++; }
    input.setSelectionRange(pos, pos);
  });
  input.addEventListener('blur', () => { input.value = formatPhone(input.value.trim()); });
}

$('#editCancel').addEventListener('click', () => { $('#editModal').style.display = 'none'; });
$('#editSave').addEventListener('click', async () => {
  const data = {
    name: $('#eName').value.trim(),
    dept: $('#eDept').value,
    position: $('#ePos').value,
    admin: $('#eAdmin').checked
  };
  for (const [el, key] of DETAIL_FIELDS) data[key] = $('#' + el).value.trim();
  try {
    if (!data.name) throw new Error('이름을 입력하세요.');
    if (editingId) {
      renderUsers(await window.api.updateUser(editingId, data));
      const pw = $('#ePw').value;
      if (pw) await window.api.resetPw(editingId, pw);
    } else {
      renderUsers(await window.api.addUser({ id: $('#eId').value.trim(), pw: $('#ePw').value || '1234', ...data }));
    }
    $('#editModal').style.display = 'none';
    refresh();
    renderDeptOrder();
  } catch (err) { $('#editError').textContent = err.message; }
});
$('#editModal').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') $('#editSave').click();
  if (e.key === 'Escape') $('#editModal').style.display = 'none';
});

$('#addBtn').addEventListener('click', () => openUserModal(null));

$('#userTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === 'del') {
      if (!confirm(`'${id}' 계정을 삭제할까요?`)) return;
      renderUsers(await window.api.deleteUser(id));
      refresh();
    } else if (btn.dataset.act === 'edit') {
      const users = await window.api.getUsers();
      const u = users.find(x => x.id === id);
      if (u) openUserModal(u);
    }
  } catch (err) { alert(err.message); }
});

$('#bulkBtn').addEventListener('click', async () => {
  try {
    const { result, users } = await window.api.bulkAdd($('#bulkText').value);
    renderUsers(users);
    $('#bulkResult').innerHTML =
      `등록 성공 ${result.ok}건` +
      (result.errors.length ? `<br>실패:<br>${result.errors.map(esc).join('<br>')}` : '');
    if (!result.errors.length) $('#bulkText').value = '';
    refresh();
  } catch (err) { alert(err.message); }
});

$('#portBtn').addEventListener('click', async () => {
  try {
    const st = await window.api.setPort($('#portInput').value);
    renderStatus(st);
    alert(st.restarting
      ? `포트를 ${st.port}(으)로 바꾸고 서버를 다시 시작합니다. 잠시 뒤 새 주소로 이동합니다.\n교직원 메신저도 새 포트로 접속해야 합니다.`
      : '포트가 변경되었습니다. 클라이언트도 새 포트로 접속해야 합니다.');
  } catch (err) { alert(err.message); }
});

// ---------- CSV ----------
$('#csvExportBtn').addEventListener('click', async () => {
  try {
    const p = await window.api.exportCsv();
    $('#csvResult').textContent = p ? '내보내기 완료: ' + p : '';
  } catch (err) { alert(err.message); }
});
$('#csvImportBtn').addEventListener('click', async () => {
  try {
    const r = await window.api.importCsv();
    if (!r) return;
    renderUsers(r.users);
    $('#csvResult').innerHTML =
      `가져오기: 성공 ${r.result.ok}건` +
      (r.result.errors.length ? `<br>실패:<br>${r.result.errors.map(esc).join('<br>')}` : '');
    refresh();
    renderDeptOrder();
  } catch (err) { alert(err.message); }
});

// ---------- 데이터 관리 ----------
function fmtBytes(n) {
  if (n > 1073741824) return (n / 1073741824).toFixed(2) + 'GB';
  if (n > 1048576) return (n / 1048576).toFixed(1) + 'MB';
  if (n > 1024) return (n / 1024).toFixed(0) + 'KB';
  return n + 'B';
}

async function refreshStorage() {
  const st = await window.api.getStorage();
  $('#stMsgCount').textContent = `쪽지 ${st.messageCount} / 채팅 ${st.roomMsgCount}`;
  $('#stFiles').textContent = `${st.uploadsCount}개 (${fmtBytes(st.uploadsSize)})`;
  $('#stDb').textContent = fmtBytes(st.dbSize);
  $('#stSched').textContent = st.scheduledCount + '건';
  if (document.activeElement !== $('#retentionInput')) $('#retentionInput').value = st.retentionDays;
}

// ---------- 데이터 저장 위치 ----------
window.api.getDataDir().then(d => { $('#dataDirNow').textContent = d; });
$('#dataDirBtn').addEventListener('click', async () => {
  try { await window.api.changeDataDir(); }
  catch (err) { alert(err.message); }
});

// ---------- 백업 ----------
$('#backupExportBtn').addEventListener('click', async () => {
  try {
    const p = await window.api.backupExport();
    $('#backupResult').textContent = p ? '백업 완료: ' + p : '';
  } catch (err) { alert(err.message); }
});
$('#backupImportBtn').addEventListener('click', async () => {
  try { await window.api.backupImport(); }
  catch (err) { alert(err.message); }
});

$('#retentionBtn').addEventListener('click', async () => {
  const days = await window.api.setRetention($('#retentionInput').value);
  $('#cleanupResult').textContent = days > 0
    ? `보관 기간이 ${days}일로 설정되었습니다. 기간이 지난 데이터는 자동 정리됩니다.`
    : '보관 기간 제한이 해제되었습니다(무제한 보관).';
  refreshStorage();
});
$('#cleanupBtn').addEventListener('click', async () => {
  if (!confirm('보관 기간이 지난 쪽지·채팅과 사용하지 않는 첨부파일을 지금 정리할까요?')) return;
  const r = await window.api.runCleanup();
  $('#cleanupResult').textContent =
    `정리 완료 — 쪽지 ${r.removedMessages}건, 채팅 ${r.removedRoomMsgs}건, 첨부파일 ${r.removedFiles}개 (${fmtBytes(r.freedBytes)} 확보)`;
  refreshStorage();
});

$('#userSearch').addEventListener('input', () => renderUsers(lastUsers));

$('#autostartChk').addEventListener('change', async (e) => {
  const on = await window.api.setAutostart(e.target.checked);
  e.target.checked = on;
});
window.api.getAutostart().then(on => { $('#autostartChk').checked = on; });

// ---------- 부서(그룹) 표시 순서 ----------
// 담당 과목으로 자동으로 생기는 '교과-과목' 그룹도 함께 순서를 정할 수 있다 (메신저 조직도와 같은 규칙)
async function renderDeptOrder() {
  const users = await window.api.getUsers();
  const saved = await window.api.getDeptOrder();
  const extra = await window.api.getExtraDepts();
  const counts = new Map();
  const derived = new Set();
  const bump = (d) => counts.set(d, (counts.get(d) || 0) + 1);
  for (const u of users) {
    if (u.id === 'admin') continue;
    const depts = u.depts && u.depts.length ? u.depts : [u.dept];
    for (const d of depts) bump(d); // 다중 부서 소속을 모두 반영
    if (u.subject) {
      const dd = '교과-' + u.subject;
      if (!depts.includes(dd)) { bump(dd); derived.add(dd); }
    }
  }
  // 메신저에서 추가한 빈 부서(소속 인원 0명)도 순서를 조정할 수 있게 포함
  for (const d of extra) if (!counts.has(d)) counts.set(d, 0);
  const isSubject = (d) => d === '교과' || d.startsWith('교과-');
  const depts = [...counts.keys()];
  // 저장된 순서 우선, 새로 생긴 부서는 뒤에 가나다순 (교과 그룹은 맨 뒤)
  const ordered = [
    ...saved.filter(d => counts.has(d)),
    ...depts.filter(d => !saved.includes(d)).sort((a, b) =>
      (isSubject(a) ? 1 : 0) - (isSubject(b) ? 1 : 0) || a.localeCompare(b, 'ko'))
  ];
  const box = $('#deptOrderList');
  box.innerHTML = '';
  ordered.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'dept-order-row' + (derived.has(d) ? ' derived' : '');
    row.draggable = true;
    row.title = '끌어서 순서를 바꿀 수 있습니다';
    const label = d.includes('-') ? d.replace('-', ' › ') : d;
    row.innerHTML = `<span class="msi do-grip">drag_indicator</span><span class="do-name">${i + 1}. ${esc(label)}</span>
      ${derived.has(d) ? '<span class="do-tag" title="교직원의 담당 과목으로 자동 구성">과목 자동</span>' : ''}
      <span class="do-cnt">${counts.get(d) ? counts.get(d) + '명' : '비어 있음'}</span>
      <button data-dir="-1" ${i === 0 ? 'disabled' : ''} title="위로"><span class="msi">arrow_upward</span></button>
      <button data-dir="1" ${i === ordered.length - 1 ? 'disabled' : ''} title="아래로"><span class="msi">arrow_downward</span></button>`;
    row.querySelectorAll('button').forEach(b => b.onclick = async () => {
      const j = i + Number(b.dataset.dir);
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      await window.api.setDeptOrder(ordered);
      renderDeptOrder();
    });
    // 드래그앤드롭으로 순서 변경
    row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', d));
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const dragged = e.dataTransfer.getData('text/plain');
      if (!dragged || dragged === d) return;
      const next = ordered.filter(x => x !== dragged);
      next.splice(next.indexOf(d), 0, dragged);
      await window.api.setDeptOrder(next);
      renderDeptOrder();
    });
    box.appendChild(row);
  });
  if (!ordered.length) box.innerHTML = '<div class="hint">등록된 사용자가 없습니다.</div>';
}
renderDeptOrder();
setInterval(renderDeptOrder, 15000);

// ---------- 회원가입 요청 ----------
function fmtLogTime(t) {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function renderSignups(list) {
  $('#signupCnt').style.display = list.length ? '' : 'none';
  $('#signupCnt').textContent = list.length;
  $('#navSignupCnt').style.display = list.length ? '' : 'none';
  $('#navSignupCnt').textContent = list.length;
  const box = $('#signupList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="hint">대기 중인 가입 요청이 없습니다.</div>';
    return;
  }
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'signup-row';
    row.innerHTML = `
      <span class="su-main">${esc(s.name)} (${esc(s.id)})</span>
      <span class="su-sub">${esc(s.dept)} · ${esc(s.position)}${s.subject ? ' · ' + esc(s.subject) : ''}</span>
      <span class="su-sub">☎ ${esc(s.phone)}${s.mobile ? ' · 📱 ' + esc(s.mobile) : ''}${s.email ? ' · ✉ ' + esc(s.email) : ''}</span>
      <span class="su-sub">${fmtLogTime(s.time)}</span>
      <span class="spacer2"></span>
      <button class="mini primary" data-act="ok">승인</button>
      <button class="mini danger" data-act="no">거절</button>`;
    row.querySelector('[data-act=ok]').onclick = async () => {
      try {
        renderSignups(await window.api.approveSignup(s.reqId));
        refresh();
        alert(`'${s.name}(${s.id})' 계정이 생성되었습니다.`);
      } catch (err) { alert(err.message); refreshSignups(); }
    };
    row.querySelector('[data-act=no]').onclick = async () => {
      if (!confirm(`'${s.name}(${s.id})' 가입 요청을 거절할까요?`)) return;
      try { renderSignups(await window.api.rejectSignup(s.reqId)); }
      catch (err) { alert(err.message); refreshSignups(); }
    };
    box.appendChild(row);
  }
}

async function refreshSignups() {
  renderSignups(await window.api.getSignups());
}
refreshSignups();
setInterval(refreshSignups, 5000);

// ---------- 활동 로그 ----------
async function refreshLogs() {
  const logs = await window.api.getLogs();
  $('#logList').innerHTML = logs.length
    ? logs.map(l => `<div><span class="lt">[${fmtLogTime(l.time)}]</span> ${esc(l.text)}</div>`).join('')
    : '<div>아직 기록된 로그가 없습니다.</div>';
}
$('#logRefreshBtn').addEventListener('click', refreshLogs);
$('#logOpenBtn').addEventListener('click', () => window.api.openLog());
refreshLogs();
setInterval(refreshLogs, 10000);

// ---------- 프로그램 정보 ----------
$('#aboutBtn').addEventListener('click', async () => {
  $('#aboutVersion').textContent = 'v' + await window.api.getAppVersion();
  $('#aboutModal').style.display = 'flex';
});
$('#aboutClose').addEventListener('click', () => { $('#aboutModal').style.display = 'none'; });
window.api.getAppVersion().then(v => { $('#verTile').textContent = 'v' + v; });
$('#webLogoutBtn').addEventListener('click', () => window.api.webLogout && window.api.webLogout());

// ---------- 프로그램 업데이트 (GitHub + 직접 등록) ----------
function fmtDateTime(t) {
  if (!t) return '-';
  const d = new Date(t), p2 = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function renderUpdate(st) {
  if (!st) return;
  $('#updCur').textContent = 'v' + st.currentVersion;
  $('#updLatest').textContent = st.latest && st.latest.version ? 'v' + st.latest.version : '-';
  $('#updVersion').textContent = st.clientRegistered ? 'v' + st.clientRegistered : '없음';
  $('#updLast').textContent = st.checking ? '확인 중…' : fmtDateTime(st.lastCheck);
  const msg = $('#updMsg');
  if (st.error || st.message) {
    msg.style.display = '';
    msg.className = 'notice-box' + (st.error ? ' err' : '');
    msg.innerHTML = `<span class="msi">${st.error ? 'error' : 'info'}</span><span>${esc(st.error || st.message)}</span>`;
  } else msg.style.display = 'none';
  const dl = st.downloading;
  $('#updProgress').style.display = dl ? '' : 'none';
  if (dl) {
    const pct = dl.total ? Math.round(dl.received / dl.total * 100) : 0;
    $('#updProgress i').style.width = pct + '%';
    $('#updProgress span').textContent = `${dl.name} 내려받는 중 ${pct}% (${fmtBytes(dl.received)}${dl.total ? ' / ' + fmtBytes(dl.total) : ''})`;
  }
  const p = st.pending;
  $('#updPendingRow').style.display = p ? '' : 'none';
  $('#navUpdDot').style.display = p ? '' : 'none';
  if (p) {
    $('#updPendingText').textContent = st.installing
      ? `서버 v${p.version} 을(를) 설치하는 중입니다. 잠시 뒤 서버가 다시 시작됩니다…`
      : `서버 v${p.version} 업데이트가 준비되었습니다.` +
        (st.options.autoInstall ? ` 접속한 사람이 없을 때 자동으로 설치합니다 (지금 접속 ${st.online}명).` : '');
    $('#updInstallBtn').disabled = !!st.installing;
  }
  $('#updCheckBtn').disabled = !!st.checking;
  if (document.activeElement !== $('#updRepo')) $('#updRepo').value = st.options.repo || '';
  $('#updEnabled').checked = !!st.options.enabled;
  $('#updAuto').checked = !!st.options.autoInstall;
  $('#updToken').placeholder = st.options.hasToken ? '저장된 토큰 있음 (바꾸려면 새로 입력)' : '공개 저장소면 비워 두세요';
  $('#updTokenClear').style.display = st.options.hasToken ? '' : 'none';
}

async function refreshUpdate() {
  try { renderUpdate(await window.api.getUpdateState()); } catch (e) {}
}
$('#updCheckBtn').addEventListener('click', async () => {
  $('#updCheckBtn').disabled = true;
  try { renderUpdate(await window.api.checkUpdate()); }
  catch (err) { alert(err.message); }
  finally { refreshUpdate(); }
});
$('#updInstallBtn').addEventListener('click', async () => {
  const online = Number(($('#onlineCount').textContent.match(/\d+/) || [0])[0]);
  if (!confirm(`지금 서버 업데이트를 설치할까요?\n서버가 잠시(약 1분) 멈췄다가 다시 시작됩니다.` +
    (online ? `\n지금 접속한 ${online}명은 연결이 끊겼다가 자동으로 다시 연결됩니다.` : ''))) return;
  try { await window.api.installServerUpdate(); refreshUpdate(); }
  catch (err) { alert(err.message); }
});
async function saveUpdateOptions(extra) {
  try {
    const o = { repo: $('#updRepo').value, enabled: $('#updEnabled').checked, autoInstall: $('#updAuto').checked, ...extra };
    if ($('#updToken').value.trim()) o.token = $('#updToken').value.trim();
    renderUpdate(await window.api.setUpdateOptions(o));
    $('#updToken').value = '';
    return true;
  } catch (err) { alert(err.message); refreshUpdate(); return false; }
}
$('#updSaveBtn').addEventListener('click', async () => { if (await saveUpdateOptions()) alert('업데이트 설정을 저장했습니다.'); });
$('#updEnabled').addEventListener('change', () => saveUpdateOptions());
$('#updAuto').addEventListener('change', () => saveUpdateOptions());
$('#updTokenClear').addEventListener('click', () => {
  if (confirm('저장된 GitHub 토큰을 지울까요?')) saveUpdateOptions({ token: '' });
});
$('#updRegisterBtn').addEventListener('click', async () => {
  try {
    const r = await window.api.registerClientUpdate();
    if (!r) return;
    $('#updVersion').textContent = 'v' + r.version;
    alert(`클라이언트 v${r.version} 설치파일이 등록되었습니다.\n이전 버전 클라이언트가 로그인하면 자동으로 업데이트됩니다.`);
  } catch (err) { alert(err.message); }
});
window.api.onUpdateState?.(renderUpdate);
refreshUpdate();
setInterval(refreshUpdate, 15000);

// ---------- 학교 이름 ----------
function applySchoolName(name) {
  $('#brandTitle').textContent = name ? name + ' 메신저 서버' : '학교메신저 서버';
  document.title = $('#brandTitle').textContent;
  if (document.activeElement !== $('#schoolInput')) $('#schoolInput').value = name || '';
}

$('#schoolBtn').addEventListener('click', async () => {
  const name = await window.api.setSchoolName($('#schoolInput').value);
  applySchoolName(name);
  alert(name ? `학교 이름이 '${name}'(으)로 설정되었습니다.` : '학교 이름이 지워졌습니다.');
});
$('#schoolSave').addEventListener('click', async () => {
  const name = await window.api.setSchoolName($('#schoolFirstInput').value);
  applySchoolName(name);
  $('#schoolModal').style.display = 'none';
});
$('#schoolSkip').addEventListener('click', () => { $('#schoolModal').style.display = 'none'; });
$('#schoolFirstInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#schoolSave').click(); });

window.api.getSettings().then(s => {
  applySchoolName(s.schoolName || '');
  if (!s.schoolName) {
    // 첫 실행: 학교 이름 입력 안내
    $('#schoolModal').style.display = 'flex';
    $('#schoolFirstInput').focus();
  }
});

// ---------- 리눅스(웹 관리 화면)에 맞게 문구 바꾸기 ----------
window.api.getPlatform?.().then(p => {
  if (p !== 'linux') return;
  $('#autostartLabel').textContent = '부팅 시 서버 자동 실행';
  $('#autostartHint').textContent = 'install.sh 로 설치하면 systemd 서비스(school-messenger-server)로 등록되어 부팅 때 자동으로 실행됩니다.';
  $('#autostartChk').disabled = true;
  $('#logOpenLb').textContent = '로그 파일 내려받기';
  $('#dataDirBtn').title = '리눅스 버전은 설정 파일에서 바꿉니다';
});

window.api.onStatus(renderStatus);
window.api.onUsers(renderUsers);
window.api.getDataDir().then(d => { $('#dataDir').textContent = d; });
refresh();
refreshStorage();
setInterval(refresh, 5000);
setInterval(refreshStorage, 30000);
