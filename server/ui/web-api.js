'use strict';
// 웹 관리 화면(리눅스 서버)용 window.api — 윈도우 관리 프로그램(Electron)에서는 preload 가 이미 만들어 두므로 아무것도 하지 않음
(() => {
  if (window.api) return;
  document.documentElement.classList.add('web-admin');
  const KEY = 'smAdminToken';
  let token = sessionStorage.getItem(KEY) || '';
  let ready = null;      // 로그인될 때까지 기다리는 약속
  let readyResolve = null;

  function waitLogin() {
    if (!ready) {
      ready = new Promise(r => { readyResolve = r; });
      showLogin();
    }
    return ready;
  }

  function showLogin(msg) {
    const build = () => {
      let box = document.getElementById('webLogin');
      if (!box) {
        box = document.createElement('div');
        box.id = 'webLogin';
        box.className = 'modal-bg';
        box.style.zIndex = '100';
        box.innerHTML = `<form class="modal web-login" autocomplete="on">
            <div class="web-login-logo"><span class="msi">admin_panel_settings</span></div>
            <h2>학교메신저 서버 관리</h2>
            <p class="hint" style="margin:0 0 14px">관리자 권한이 있는 메신저 계정으로 로그인하세요.</p>
            <label>아이디</label><input id="wlId" autocomplete="username" required>
            <label>비밀번호</label><input id="wlPw" type="password" autocomplete="current-password" required>
            <div id="wlErr" class="error"></div>
            <div class="modal-btns"><button class="primary" type="submit">로그인</button></div>
          </form>`;
        document.body.appendChild(box);
        box.querySelector('form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = box.querySelector('#wlErr');
          err.textContent = '';
          try {
            const r = await fetch('api/login', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: box.querySelector('#wlId').value, pw: box.querySelector('#wlPw').value })
            }).then(x => x.json());
            if (!r.ok) { err.textContent = r.error || '로그인 실패'; return; }
            token = r.token;
            sessionStorage.setItem(KEY, token);
            box.style.display = 'none';
            box.querySelector('#wlPw').value = '';
            const done = readyResolve;
            ready = null; readyResolve = null;
            if (done) done();
          } catch (ex) { err.textContent = '서버에 연결할 수 없습니다.'; }
        });
      }
      box.style.display = 'flex';
      if (msg) box.querySelector('#wlErr').textContent = msg;
      setTimeout(() => box.querySelector('#wlId').focus(), 0);
    };
    if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
  }

  async function call(fn, ...args) {
    if (!token) await waitLogin();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch('api/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
        body: JSON.stringify({ fn, args })
      });
      if (res.status === 401 || res.status === 403) {
        token = '';
        sessionStorage.removeItem(KEY);
        await waitLogin();
        continue;
      }
      const r = await res.json();
      if (!r.ok) throw new Error(r.error || '요청에 실패했습니다.');
      return r.result;
    }
    throw new Error('로그인이 필요합니다.');
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = accept;
      inp.onchange = () => resolve(inp.files[0] || null);
      inp.click();
    });
  }

  async function upload(what, file) {
    if (!token) await waitLogin();
    const res = await fetch(`api/upload/${what}?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'X-Admin-Token': token }, body: file
    });
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || '올리기에 실패했습니다.');
    return r.result;
  }

  async function download(what, name) {
    if (!token) await waitLogin();
    const res = await fetch('api/download/' + what, { headers: { 'X-Admin-Token': token } });
    if (!res.ok) throw new Error('내려받기에 실패했습니다.');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return name;
  }

  const poll = (fn, cb, ms) => { setInterval(() => { if (!document.hidden) call(fn).then(cb).catch(() => {}); }, ms); };
  const names = ['getStatus', 'getUsers', 'getSettings', 'getDataDir', 'addUser', 'updateUser', 'deleteUser', 'resetPw',
    'bulkAdd', 'getAutostart', 'setAutostart', 'setSchoolName', 'getDeptOrder', 'getExtraDepts', 'setDeptOrder',
    'getSignups', 'approveSignup', 'rejectSignup', 'getLogs', 'backupExport', 'changeDataDir', 'getAppVersion',
    'getClientUpdate', 'getStorage', 'setRetention', 'runCleanup', 'getPlatform', 'getUpdateState',
    'setUpdateOptions', 'checkUpdate', 'installServerUpdate'];
  const api = {};
  for (const n of names) api[n] = (...a) => call(n, ...a);
  Object.assign(api, {
    refocus: () => {},
    setPort: async (port) => {
      const st = await call('setPort', port);
      // 새 포트로 다시 시작하므로 잠시 뒤 새 주소로 이동
      setTimeout(() => { location.href = `${location.protocol}//${location.hostname}:${st.port}/admin/`; }, 4000);
      return st;
    },
    exportCsv: () => download('users.csv', '사용자목록.csv').then(n => n + ' (브라우저 다운로드 폴더)'),
    importCsv: async () => {
      const f = await pickFile('.xlsx,.xls,.csv,.txt');
      return f ? upload('users', f) : null;
    },
    registerClientUpdate: async () => {
      const f = await pickFile('.exe');
      return f ? upload('client-update', f) : null;
    },
    backupImport: async () => {
      const list = await call('listBackups');
      if (!list.length) throw new Error('서버에 저장된 백업이 없습니다. 먼저 [백업 내보내기]를 하세요.');
      const pick = prompt('복원할 백업 번호를 입력하세요. 현재 데이터가 모두 바뀌고 서버가 다시 시작됩니다.\n\n' +
        list.map((n, i) => `${i + 1}. ${n}`).join('\n'), '1');
      const name = list[Number(pick) - 1];
      if (!name) return null;
      await call('backupImport', name);
      alert('복원 중입니다. 서버가 다시 시작되면 화면을 새로 고칩니다.');
      setTimeout(() => location.reload(), 6000);
      return null;
    },
    openLog: () => download('activity.log', 'activity.log').catch(e => alert(e.message)),
    onStatus: (cb) => poll('getStatus', cb, 3000),
    onUsers: (cb) => poll('getUsers', cb, 5000),
    onUpdateState: (cb) => poll('getUpdateState', cb, 3000),
    webLogout: async () => {
      try { await fetch('api/logout', { method: 'POST', headers: { 'X-Admin-Token': token } }); } catch (e) {}
      sessionStorage.removeItem(KEY);
      location.reload();
    }
  });
  window.api = api;
  if (!token) waitLogin();
})();
