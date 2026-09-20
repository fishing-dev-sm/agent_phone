#!/usr/bin/env python3
"""Configure the known HT802 on the LAN (new SPA firmware API); keep a scoped rollback file."""
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
BACKUP = ROOT / '.runtime' / 'ht802-original.json'
DEVICE_IP = os.environ.get('HT802_ADDRESS', '192.168.1.150')
SIP_HOST = os.environ.get('HT802_LOCAL_ADDRESS', '192.168.1.10')
SIP_PORT = int(os.environ.get('HT802_SIP_PORT', '5090'))
PASSWORD = os.environ.get('HT802_PASSWORD', '')
EXPECTED_MAC = os.environ.get('HT802_EXPECTED_MAC', '').replace(':', '').upper()
if not PASSWORD:
    raise SystemExit('请设置 HT802_PASSWORD（新固件用机身标签上的默认密码）')
device_octets = DEVICE_IP.split('.')
if len(device_octets) != 4 or any(not part.isdigit() or not 0 <= int(part) <= 255 for part in device_octets):
    raise ValueError('HT802_ADDRESS must be an IPv4 address')
BASE = f'https://{DEVICE_IP}/cgi-bin/'

# FXS 1 profile only. Network stays on DHCP; pin the lease on the router instead.
# V2: P31 = SIP Registration (on); V1 semantics differed — upstream set 0.
CHANGES = {'P47': f'{SIP_HOST}:{SIP_PORT}', 'P35': 'redline', 'P4060': 'redline', 'P31': '1',
           'P271': '1', 'P71': '263', 'P4045': '0', 'P850': '101', 'P870': '0',
           'P20501': '0', 'P20505': '0',
           'P4010': 'c=2000/4000;'}
INSPECT_EXTRA = ['P8', 'P40']

opener = urllib.request.build_opener(
    # The HT802 serves a self-signed certificate; identity is pinned by EXPECTED_MAC.
    urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def post(page, values):
    data = urllib.parse.urlencode(values).encode()
    request = urllib.request.Request(BASE + page, data, headers={'X-Requested-With': 'XMLHttpRequest'})
    with opener.open(request, timeout=8) as response:
        return json.loads(response.read().decode('utf-8'))


def result(payload, what):
    if payload.get('response') != 'success':
        raise RuntimeError(f'{what} 失败：{payload}')
    return payload.get('body') or {}


def arp_mac(ip):
    for command in (['ip', 'neigh', 'show', 'to', ip], ['arp', '-n', ip]):
        try:
            out = subprocess.run(command, capture_output=True, text=True, timeout=5).stdout
        except OSError:
            continue
        match = re.search(r'([0-9a-f]{2}:){5}[0-9a-f]{2}', out, re.I)
        if match:
            return match.group(0).replace(':', '').upper()
    return ''


def login():
    body = result(post('dologin', {'username': 'admin',
                                   'P2': base64.b64encode(PASSWORD.encode()).decode()}), '登录')
    if body.get('role') != 'admin':
        raise RuntimeError(f'登录角色异常：{body}')
    return body['session_token']


def get_values(token, codes):
    return result(post('api.values.get', {'request': ':'.join(codes), 'session_token': token}), '读取配置')


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'inspect'
    if action not in ('inspect', 'configure', 'restore'):
        raise ValueError('inspect | configure | restore')
    if EXPECTED_MAC:
        actual_mac = arp_mac(DEVICE_IP)
        if actual_mac != EXPECTED_MAC:
            raise RuntimeError(f'{DEVICE_IP} 的 MAC ({actual_mac or "未知"}) 与 HT802_EXPECTED_MAC 不符；没有修改设备')
    token = login()
    product = post('api-get_system_base_info', {'session_token': token}).get('body', {})
    if 'HT802' not in str(product.get('product', '')):
        raise RuntimeError(f'登录目标未识别为 HT802（{product}）；没有修改设备')
    original = get_values(token, list(CHANGES))
    if action == 'inspect':
        extra = get_values(token, INSPECT_EXTRA)
        print(json.dumps({'product': product, 'profile': original, 'network': extra},
                         ensure_ascii=False, indent=2))
        return
    if action == 'configure':
        BACKUP.parent.mkdir(mode=0o700, exist_ok=True)
        # Preserve the first baseline through restarts and repeated configure calls.
        if not BACKUP.exists():
            fd = os.open(BACKUP, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump(original, stream, indent=2)
        changes = CHANGES
    else:
        changes = json.loads(BACKUP.read_text())
    result(post('api.values.post', {**changes, 'update': '1', 'session_token': token}), '保存配置')
    # update=1 invalidates the session; log in again before verifying.
    token = login()
    # Verify the saved values before rebooting into them.
    actual = get_values(token, list(changes))
    if any(actual.get(key) != str(value) for key, value in changes.items()):
        raise RuntimeError(f'保存后与预期不符：{actual}；未继续重启')
    try:
        post('rs', {'session_token': token})
    except Exception:
        pass  # The device may drop the connection while rebooting.
    print(json.dumps({'action': action, 'saved': True, 'reboot_requested': True,
                      'backup': str(BACKUP)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
