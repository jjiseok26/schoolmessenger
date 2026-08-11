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

// ---------- 좌측 메뉴 트리 ----------
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x === item));
    const sec = document.getElementById(item.dataset.target);
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

function renderStatus(s) {
  $('#statusBadge').textContent = s.running ? '실행 중' : '중지됨';
  $('#statusBadge').className = 'badge ' + (s.running ? 'on' : 'off');
  const addrs = (s.ips.length ? s.ips : ['127.0.0.1']).map(ip => ip + ':' + (s.port ?? '-'));
  $('#addrList').innerHTML = addrs.map(esc).join('<br>');
  if (document.activeElement !== $('#portInput')) $('#portInput').value = s.port ?? '';
  $('#userCount').textContent = s.userCount + '명';
  $('#onlineCount').textContent = s.online.length + '명';
  onlineSet = new Set(s.online);
}

function renderUsers(users) {
  lastUsers = users;
  // 이미 등록된 부서/학년을 선택할 수 있게 제공
  $('#fDeptList').innerHTML =
    [...new Set(users.filter(u => u.id !== 'admin').flatMap(u => u.depts || [u.dept]))]
      .sort((a, b) => a.localeCompare(b, 'ko'))
      .map(d => `<option value="${esc(d)}">`).join('');
  const q = $('#userSearch').value.trim().toLowerCase();
  const tb = $('#userTable tbody');
  tb.innerHTML = '';
  for (const u of users) {
    const deptsStr = (u.depts || [u.dept]).join(', ');
    if (q && !(u.id.toLowerCase().includes(q) || u.name.toLowerCase().includes(q) ||
               deptsStr.toLowerCase().includes(q) || (u.position || '').toLowerCase().includes(q))) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="dot ${u.online ? 'on' : 'off'}"></span></td>
      <td>${esc(u.id)}</td>
      <td>${esc(u.name)}</td>
      <td>${esc(deptsStr)}</td>
      <td>${esc(u.position)}</td>
      <td>${u.admin ? '관리자' : '일반'}</td>
      <td>
        <button class="mini" data-act="edit" data-id="${esc(u.id)}">수정·비밀번호</button>
        ${u.id !== 'admin' ? `<button class="mini danger" data-act="del" data-id="${esc(u.id)}">삭제</button>` : ''}
      </td>`;
    tb.appendChild(tr);
  }
}

async function refresh() {
  renderStatus(await window.api.getStatus());
  renderUsers(await window.api.getUsers());
}

// 계정 수정 모달 (Electron은 window.prompt를 지원하지 않으므로 자체 모달 사용)
function openEditModal(u) {
  $('#editId').textContent = u.id;
  $('#eName').value = u.name;
  $('#eDept').value = (u.depts || [u.dept]).join(', ');
  $('#ePos').value = u.position || '';
  $('#eAdmin').checked = !!u.admin;
  $('#ePw').value = '';
  $('#editModal').style.display = 'flex';
  $('#eName').focus();
}

$('#editCancel').addEventListener('click', () => { $('#editModal').style.display = 'none'; });
$('#editSave').addEventListener('click', async () => {
  const id = $('#editId').textContent;
  try {
    renderUsers(await window.api.updateUser(id, {
      name: $('#eName').value,
      dept: $('#eDept').value,
      position: $('#ePos').value,
      admin: $('#eAdmin').checked
    }));
    const pw = $('#ePw').value;
    if (pw) await window.api.resetPw(id, pw);
    $('#editModal').style.display = 'none';
    refresh();
  } catch (err) { alert(err.message); }
});

$('#userTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === 'del') {
      if (!confirm(`'${id}' 계정을 삭제할까요?`)) return;
      renderUsers(await window.api.deleteUser(id));
      refresh();
    } else if (btn.dataset.act === 'edit' || btn.dataset.act === 'pw') {
      const users = await window.api.getUsers();
      const u = users.find(x => x.id === id);
      if (u) openEditModal(u);
    }
  } catch (err) { alert(err.message); }
});

$('#addBtn').addEventListener('click', async () => {
  try {
    renderUsers(await window.api.addUser({
      id: $('#fId').value, name: $('#fName').value, dept: $('#fDept').value,
      position: $('#fPos').value, pw: $('#fPw').value || '1234', admin: $('#fAdmin').checked
    }));
    for (const s of ['#fId', '#fName', '#fDept', '#fPos', '#fPw']) $(s).value = '';
    $('#fAdmin').checked = false;
    refresh();
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
    renderStatus(await window.api.setPort($('#portInput').value));
    alert('포트가 변경되었습니다. 클라이언트도 새 포트로 접속해야 합니다.');
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
async function renderDeptOrder() {
  const users = await window.api.getUsers();
  const saved = await window.api.getDeptOrder();
  const counts = new Map();
  for (const u of users) {
    if (u.id === 'admin') continue;
    counts.set(u.dept, (counts.get(u.dept) || 0) + 1);
  }
  const depts = [...counts.keys()];
  // 저장된 순서 우선, 새로 생긴 부서는 뒤에 가나다순
  const ordered = [
    ...saved.filter(d => counts.has(d)),
    ...depts.filter(d => !saved.includes(d)).sort((a, b) => a.localeCompare(b, 'ko'))
  ];
  const box = $('#deptOrderList');
  box.innerHTML = '';
  ordered.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'dept-order-row';
    row.draggable = true;
    row.title = '드래그해서 순서를 바꿀 수 있습니다';
    row.innerHTML = `<span class="do-grip">⠿</span><span class="do-name">${i + 1}. ${esc(d)}</span>
      <span class="do-cnt">${counts.get(d)}명</span>
      <button data-dir="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button data-dir="1" ${i === ordered.length - 1 ? 'disabled' : ''}>▼</button>`;
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

// ---------- 클라이언트 자동 업데이트 ----------
async function refreshClientUpdate() {
  const u = await window.api.getClientUpdate();
  $('#updVersion').textContent = u ? 'v' + u.version : '없음';
}
$('#updRegisterBtn').addEventListener('click', async () => {
  try {
    const r = await window.api.registerClientUpdate();
    if (!r) return;
    $('#updVersion').textContent = 'v' + r.version;
    alert(`클라이언트 v${r.version} 설치파일이 등록되었습니다.\n이전 버전 클라이언트가 로그인하면 자동으로 안내됩니다.`);
  } catch (err) { alert(err.message); }
});
refreshClientUpdate();

// ---------- 학교 이름 ----------
function applySchoolName(name) {
  $('#brandTitle').textContent = '🏫 ' + (name ? name + ' 메신저 서버' : '학교메신저 서버');
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

window.api.onStatus(renderStatus);
window.api.onUsers(renderUsers);
window.api.getDataDir().then(d => { $('#dataDir').textContent = d; });
refresh();
refreshStorage();
setInterval(refresh, 5000);
setInterval(refreshStorage, 30000);
