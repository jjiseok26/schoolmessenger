'use strict';
// GitHub 자동 업데이트 관리 (윈도우 서버·리눅스 서버 공용)
//  1) 6시간마다(그리고 시작 20초 뒤) 최신 릴리스 확인
//  2) 새 클라이언트 설치파일 → 내려받아 '클라이언트 자동 업데이트'에 바로 등록 (교직원 PC 는 서버에서 받아 감)
//  3) 새 서버 설치파일 → 내려받아 두었다가 [지금 설치] 또는 자동 설치(접속자가 아무도 없을 때)
const fs = require('fs');
const path = require('path');
const { GithubUpdater, DEFAULT_REPO, verNewer, cleanRepo } = require('./updater');

const CHECK_EVERY = 6 * 3600000;

class UpdateManager {
  // server: MessengerServer, options: 저장된 설정 객체(직접 고침), saveOptions(): 설정 저장
  // currentVersion: 지금 서버 버전, serverAssetKind: 'serverWin' | 'serverLinux'
  // workDir: 서버 설치파일을 받아 둘 폴더, install(pending): 실제 설치 (실행 환경마다 다름)
  constructor({ server, options, saveOptions, currentVersion, serverAssetKind, workDir, install, apiBase }) {
    this.server = server;
    this.options = options;
    this.saveOptions = saveOptions || (() => {});
    this.currentVersion = currentVersion;
    this.serverAssetKind = serverAssetKind;
    this.workDir = workDir;
    this.install = install;
    this.apiBase = apiBase;
    this.onChange = null;
    if (!this.options.repo) this.options.repo = DEFAULT_REPO;
    if (this.options.enabled === undefined) this.options.enabled = true;
    if (this.options.autoInstall === undefined) this.options.autoInstall = true;
    this.state = {
      checking: false, lastCheck: this.options.lastCheck || 0, latest: null, error: '',
      downloading: null, pending: null, installing: false, message: ''
    };
    this._syncPublicRepo();
  }

  start() {
    this._cleanupOld();
    this._t1 = setTimeout(() => { if (this.options.enabled) this.check(false); }, 20000);
    this._t2 = setInterval(() => { if (this.options.enabled) this.check(false); }, CHECK_EVERY);
    this._t3 = setInterval(() => this._idleInstall(), 60000);
  }

  stop() {
    clearTimeout(this._t1); clearInterval(this._t2); clearInterval(this._t3);
  }

  // 토큰이 없으면 공개 저장소로 보고 클라이언트에게도 알려 줌 (서버를 거치지 않고 GitHub 에서 직접 받을 수 있게)
  _syncPublicRepo() {
    this.server.updateRepoPublic = this.options.enabled && !this.options.token ? cleanRepo(this.options.repo) : '';
  }

  _changed() {
    if (this.onChange) try { this.onChange(this.getState()); } catch (e) {}
  }

  getState() {
    return {
      ...this.state,
      currentVersion: this.currentVersion,
      clientRegistered: this.server.clientUpdate ? this.server.clientUpdate.version : '',
      online: this.server.sockets.size,
      options: {
        repo: this.options.repo, enabled: !!this.options.enabled,
        autoInstall: !!this.options.autoInstall, hasToken: !!this.options.token
      }
    };
  }

  setOptions(o = {}) {
    if (o.repo !== undefined) {
      const r = cleanRepo(o.repo);
      if (!r) throw new Error('저장소는 "소유자/저장소이름" 형식으로 입력하세요. (예: ' + DEFAULT_REPO + ')');
      this.options.repo = r;
    }
    if (o.token !== undefined) this.options.token = String(o.token || '').trim(); // '' = 토큰 지우기
    if (o.enabled !== undefined) this.options.enabled = !!o.enabled;
    if (o.autoInstall !== undefined) this.options.autoInstall = !!o.autoInstall;
    this.saveOptions();
    this._syncPublicRepo();
    this._changed();
    return this.getState();
  }

  // 지금 확인 (manual = 관리자가 버튼으로 요청)
  async check(manual) {
    if (this.state.checking) return this.getState();
    this.state.checking = true;
    this.state.error = '';
    this.state.message = '';
    this._changed();
    try {
      const gh = new GithubUpdater({ repo: this.options.repo, token: this.options.token, apiBase: this.apiBase });
      const rel = await gh.latest();
      const ca = rel.assets.client;
      const sa = rel.assets[this.serverAssetKind];
      this.state.latest = {
        version: rel.version, tag: rel.tag, url: rel.url, published: rel.published, notes: rel.notes,
        client: ca ? ca.version : '', server: sa ? sa.version : ''
      };
      const notes = [];
      // 클라이언트: 등록된 것보다 새 버전이면 받아서 바로 배포 등록
      const reg = this.server.clientUpdate ? this.server.clientUpdate.version : '';
      if (ca && (!reg || verNewer(ca.version, reg))) {
        const tmp = path.join(this.server.updateDir, `client-setup-${ca.version}.exe.download`);
        await gh.download(ca, tmp, (got, total) => this._progress(ca.name, got, total));
        this.server.adoptClientUpdate(tmp, ca.version);
        notes.push(`클라이언트 v${ca.version} 을(를) 받아 배포 등록했습니다.`);
      }
      // 서버: 지금보다 새 버전이면 받아 두기
      if (sa && verNewer(sa.version, this.currentVersion)) {
        const dest = path.join(this.workDir, sa.name);
        const have = this.state.pending && this.state.pending.version === sa.version && fs.existsSync(this.state.pending.file);
        if (!have) {
          await gh.download(sa, dest, (got, total) => this._progress(sa.name, got, total));
          this.state.pending = { version: sa.version, file: dest, name: sa.name };
          this.server.log(`서버 v${sa.version} 업데이트 파일을 받았습니다 (GitHub)`);
        }
        notes.push(this.options.autoInstall
          ? `서버 v${sa.version} 을(를) 받았습니다. 접속자가 없을 때 자동으로 설치합니다.`
          : `서버 v${sa.version} 을(를) 받았습니다. [서버 업데이트 설치]를 누르면 설치합니다.`);
      }
      if (!notes.length) notes.push(`최신 버전입니다. (GitHub 최신: v${rel.version || '-'})`);
      this.state.message = notes.join(' ');
      if (manual) this.server.log('업데이트 확인(수동): ' + this.state.message);
    } catch (e) {
      this.state.error = e.message;
      this.server.log('업데이트 확인 실패: ' + e.message);
    } finally {
      this.state.checking = false;
      this.state.downloading = null;
      this.state.lastCheck = Date.now();
      this.options.lastCheck = this.state.lastCheck;
      this.saveOptions();
      this._changed();
    }
    return this.getState();
  }

  _progress(name, received, total) {
    const prev = this.state.downloading;
    this.state.downloading = { name, received, total };
    // 화면 갱신은 1MB 마다만
    if (!prev || prev.name !== name || received - prev.shown >= 1048576 || received === total) {
      this.state.downloading.shown = received;
      this._changed();
    } else {
      this.state.downloading.shown = prev.shown;
    }
  }

  _idleInstall() {
    if (!this.options.autoInstall || !this.state.pending || this.state.installing) return;
    if (this.server.sockets.size > 0) return; // 쓰는 사람이 있으면 기다림
    this.installNow('auto').catch(e => this.server.log('자동 설치 실패: ' + e.message));
  }

  async installNow(reason) {
    const p = this.state.pending;
    if (!p || !fs.existsSync(p.file)) {
      this.state.pending = null;
      throw new Error('설치할 업데이트 파일이 없습니다. [지금 확인]을 먼저 눌러 주세요.');
    }
    if (this.state.installing) return;
    this.state.installing = true;
    this._changed();
    this.server.log(`서버 v${p.version} 설치 시작 (${reason === 'auto' ? '자동 — 접속자 없음' : '관리자 요청'})`);
    try {
      await this.install(p);
    } catch (e) {
      this.state.installing = false;
      this._changed();
      throw e;
    }
  }

  // 이미 적용된(현재 버전 이하) 설치파일 정리
  _cleanupOld() {
    try {
      for (const f of fs.readdirSync(this.workDir)) {
        const m = /(\d+\.\d+\.\d+)/.exec(f);
        if (m && !verNewer(m[1], this.currentVersion)) fs.unlink(path.join(this.workDir, f), () => {});
      }
    } catch (e) {}
  }
}

module.exports = { UpdateManager };
