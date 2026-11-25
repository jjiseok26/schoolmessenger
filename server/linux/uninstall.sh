#!/bin/bash
# 학교메신저 서버 (리눅스) 제거 —  sudo bash uninstall.sh          (데이터는 남김)
#                                  sudo bash uninstall.sh --purge  (데이터까지 모두 삭제)
set -e
APP_DIR=/opt/school-messenger-server
DATA_DIR=/var/lib/school-messenger-server
SVC=school-messenger-server
RUN_USER=schoolmsg

if [ "$(id -u)" -ne 0 ]; then
  echo "관리자 권한이 필요합니다:  sudo bash uninstall.sh"
  exit 1
fi
systemctl disable --now "$SVC" 2>/dev/null || true
rm -f /etc/systemd/system/$SVC.service
systemctl daemon-reload
rm -rf "$APP_DIR"
if [ "$1" = "--purge" ]; then
  rm -rf "$DATA_DIR"
  userdel "$RUN_USER" 2>/dev/null || true
  echo "프로그램과 데이터를 모두 삭제했습니다."
else
  echo "프로그램을 삭제했습니다. 데이터는 남아 있습니다: $DATA_DIR"
fi
