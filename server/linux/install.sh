#!/bin/bash
# 학교메신저 서버 (리눅스) 설치 — 압축을 푼 폴더에서:  sudo bash install.sh
#  - 프로그램: /opt/school-messenger-server
#  - 데이터:   /var/lib/school-messenger-server (계정·쪽지·첨부파일·설정·백업)
#  - 서비스:   school-messenger-server (부팅 때 자동 실행, 꺼지면 자동 재시작)
set -e
APP_DIR=/opt/school-messenger-server
DATA_DIR=/var/lib/school-messenger-server
SVC=school-messenger-server
RUN_USER=schoolmsg
PORT=7777

if [ "$(id -u)" -ne 0 ]; then
  echo "관리자 권한이 필요합니다:  sudo bash install.sh"
  exit 1
fi

# Node.js 18 이상 확인
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 설치되어 있지 않습니다. 먼저 설치하세요."
  echo "  Ubuntu/Debian:  sudo apt install -y nodejs   (버전이 18 미만이면 리눅스설치안내.txt 참고)"
  echo "  Rocky/RHEL:     sudo dnf install -y nodejs"
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18 이상이 필요합니다. (지금: $(node -v))  리눅스설치안내.txt 를 참고하세요."
  exit 1
fi
NODE_BIN=$(command -v node)

# 서비스 전용 계정 (로그인 불가)
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
    || useradd -r -d "$DATA_DIR" -s /sbin/nologin "$RUN_USER"
fi

SRC=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$APP_DIR" "$DATA_DIR"
if [ "$SRC" != "$APP_DIR" ]; then
  systemctl stop "$SVC" 2>/dev/null || true
  cp -a "$SRC"/. "$APP_DIR"/
fi
# 서비스 계정이 프로그램 폴더를 쓸 수 있어야 GitHub 자동 업데이트가 파일을 바꿀 수 있음
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"

cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=School Messenger Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Environment=SM_HOME=$DATA_DIR
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/headless.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1
systemctl restart "$SVC"

# 방화벽이 켜져 있으면 포트 열기
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow $PORT/tcp >/dev/null && echo "방화벽(ufw): $PORT/tcp 허용"
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=$PORT/tcp >/dev/null && firewall-cmd --reload >/dev/null && echo "방화벽(firewalld): $PORT/tcp 허용"
fi

sleep 2
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
if systemctl is-active --quiet "$SVC"; then
  echo "설치 완료 — 학교메신저 서버가 실행 중입니다."
else
  echo "서비스가 시작되지 않았습니다. 기록 확인:  sudo journalctl -u $SVC -n 50"
fi
echo "  교직원 메신저 서버 주소:  ${IP:-서버IP}:$PORT"
echo "  웹 관리 화면:            http://${IP:-서버IP}:$PORT/admin   (처음 계정 admin / admin1234 — 꼭 비밀번호를 바꾸세요)"
echo "  상태 보기:   sudo systemctl status $SVC"
echo "  기록 보기:   sudo journalctl -u $SVC -f"
