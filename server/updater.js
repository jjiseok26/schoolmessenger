'use strict';
// GitHub 릴리스에서 새 버전 확인·내려받기 (Electron 비의존 — 윈도우 서버·리눅스 서버 공용)
//  - 공개 저장소: 토큰 없이 사용
//  - 비공개 저장소: 읽기 권한 토큰(fine-grained, Contents: Read-only)을 넣으면 사용
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_REPO = 'jjiseok26/schoolmessenger';
const API_BASE = 'https://api.github.com';

// 릴리스에 올리는 설치파일 이름 규칙 → 종류
const ASSET_PATTERNS = {
  client: /^SchoolMessenger-Client-Setup-(\d+\.\d+\.\d+)\.exe$/i,
  serverWin: /^SchoolMessenger-Server-Setup-(\d+\.\d+\.\d+)\.exe$/i,
  serverLinux: /^SchoolMessenger-Server-Linux-(\d+\.\d+\.\d+)\.tar\.gz$/i
};

function verNewer(a, b) { // a 가 b 보다 최신인가
  const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function cleanRepo(repo) {
  const r = String(repo || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) ? r : '';
}

class GithubUpdater {
  constructor({ repo, token, apiBase } = {}) {
    this.repo = cleanRepo(repo) || DEFAULT_REPO;
    this.token = String(token || '').trim();
    this.apiBase = (apiBase || API_BASE).replace(/\/+$/, '');
  }

  _headers(extra) {
    const h = { 'User-Agent': 'SchoolMessenger-Updater', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    return h;
  }

  // 최신 릴리스 정보: { version, tag, name, url, published, notes, assets: { client, serverWin, serverLinux } }
  async latest() {
    let res;
    try {
      res = await fetch(`${this.apiBase}/repos/${this.repo}/releases/latest`, {
        headers: this._headers({ Accept: 'application/vnd.github+json' }),
        signal: AbortSignal.timeout(20000)
      });
    } catch (e) {
      throw new Error('GitHub 에 연결할 수 없습니다. 인터넷 연결(교내망 차단 여부)을 확인하세요. (' + (e.cause?.code || e.message) + ')');
    }
    if (res.status === 404) {
      throw new Error(this.token
        ? `저장소(${this.repo})나 릴리스를 찾을 수 없습니다. 저장소 이름과 토큰 권한을 확인하세요.`
        : `저장소(${this.repo})의 릴리스를 찾을 수 없습니다. 비공개 저장소라면 GitHub 토큰을 입력하세요.`);
    }
    if (res.status === 401) throw new Error('GitHub 토큰이 올바르지 않거나 만료되었습니다.');
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub 요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요.');
    }
    if (!res.ok) throw new Error(`GitHub 응답 오류 (${res.status})`);
    const rel = await res.json();
    const assets = {};
    for (const a of rel.assets || []) {
      for (const [kind, re] of Object.entries(ASSET_PATTERNS)) {
        const m = re.exec(a.name || '');
        if (m && (!assets[kind] || verNewer(m[1], assets[kind].version))) {
          assets[kind] = {
            kind, version: m[1], name: a.name, size: Number(a.size) || 0,
            apiUrl: a.url, downloadUrl: a.browser_download_url,
            sha256: /^sha256:[0-9a-f]{64}$/i.test(a.digest || '') ? a.digest.slice(7).toLowerCase() : ''
          };
        }
      }
    }
    const tagVer = /(\d+\.\d+\.\d+)/.exec(rel.tag_name || '');
    return {
      version: tagVer ? tagVer[1] : '', tag: rel.tag_name || '', name: rel.name || '',
      url: rel.html_url || '', published: rel.published_at || '', notes: String(rel.body || '').slice(0, 4000),
      assets
    };
  }

  // 설치파일 내려받기 → dest. onProgress(받은 바이트, 전체 바이트). 크기·SHA-256(있으면) 검증 후 완성 파일로 바꿈
  async download(asset, dest, onProgress) {
    const tmp = dest + '.part';
    let res;
    const stall = new AbortController();
    let stallTimer = null;
    const kick = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => stall.abort(), 60000); };
    kick();
    try {
      if (this.token && asset.apiUrl) {
        // 비공개 저장소: API 주소로 요청하면 실제 파일 위치로 넘겨 줌 → 그 주소에는 토큰을 보내지 않는다
        res = await fetch(asset.apiUrl, {
          headers: this._headers({ Accept: 'application/octet-stream' }), redirect: 'manual', signal: stall.signal
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          const loc = new URL(res.headers.get('location'), asset.apiUrl).href;
          res = await fetch(loc, { headers: { 'User-Agent': 'SchoolMessenger-Updater' }, signal: stall.signal });
        }
      } else {
        res = await fetch(asset.downloadUrl, { headers: { 'User-Agent': 'SchoolMessenger-Updater' }, signal: stall.signal });
      }
      if (!res.ok) throw new Error(`내려받기 실패 (${res.status})`);
      const total = Number(res.headers.get('content-length')) || asset.size || 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(tmp);
      const hash = crypto.createHash('sha256');
      let received = 0;
      try {
        for await (const chunk of res.body) {
          kick();
          received += chunk.length;
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
          if (onProgress) onProgress(received, total);
        }
      } finally {
        await new Promise(r => out.end(r));
      }
      if (asset.size && received !== asset.size) throw new Error(`파일 크기가 맞지 않습니다 (${received} / ${asset.size})`);
      if (asset.sha256 && hash.digest('hex') !== asset.sha256) throw new Error('파일 검증(SHA-256)에 실패했습니다.');
      try { fs.unlinkSync(dest); } catch (e) {}
      fs.renameSync(tmp, dest);
      return dest;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      if (e.name === 'AbortError') throw new Error('내려받기가 1분 넘게 멈춰 중단했습니다.');
      throw e;
    } finally {
      clearTimeout(stallTimer);
    }
  }
}

module.exports = { GithubUpdater, DEFAULT_REPO, ASSET_PATTERNS, verNewer, cleanRepo };
