#!/bin/sh
# Создаёт infra/mosquitto/passwd с тремя пользователями. Пароли — из переменных окружения.
# MQTT_PASSWORD=... PHONE_PASSWORD=... ESP32_PASSWORD=... sh infra/mosquitto/make_passwd.sh
set -e
cd "$(dirname "$0")"
: "${MQTT_PASSWORD:?нужен MQTT_PASSWORD}" "${PHONE_PASSWORD:?нужен PHONE_PASSWORD}" "${ESP32_PASSWORD:?нужен ESP32_PASSWORD}"
mount_dir=$(pwd -W 2>/dev/null || pwd)  # Git Bash: путь с буквой диска для Docker Desktop
passwd_tmp=$(mktemp ./passwd.XXXXXX)
trap 'rm -f "$passwd_tmp"' EXIT
MSYS_NO_PATHCONV=1 docker run --rm -v "$mount_dir:/m" \
  -e MQTT_PASSWORD -e PHONE_PASSWORD -e ESP32_PASSWORD eclipse-mosquitto:2 sh -ec '
    mosquitto_passwd -b "$1" server "$MQTT_PASSWORD"
    mosquitto_passwd -b "$1" phone "$PHONE_PASSWORD"
    mosquitto_passwd -b "$1" esp32 "$ESP32_PASSWORD"
  ' sh "/m/${passwd_tmp##*/}"
chmod a+r "$passwd_tmp"  # Брокер читает файл от пользователя Mosquitto.
mv -f "$passwd_tmp" passwd
echo "Готово: infra/mosquitto/passwd (в git не попадает)"
