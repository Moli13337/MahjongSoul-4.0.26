#!/usr/bin/env python3
"""
雀魂本地全功能代理

同时监听:
  - 8080 (HTTP) - Gateway 路由请求
  - 80   (HTTP) - CDN HTTP 请求
  - 443  (HTTPS) - CDN HTTPS 请求（自签证书）

所有请求最终转发到本地私服资源服务器 (8440)。

使用方法:
  1. 以管理员身份运行: python local_proxy.py
  2. 确保 hosts 文件已配置（patch_config.py 会自动配置）
  3. 启动私服: npm start
  4. 启动游戏客户端
"""

import json
import ssl
import sys
import os
import ipaddress
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
CONFIG_PATH = SCRIPT_DIR / "patch_config.json"

def load_config():
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "private_server_host": "127.0.0.1",
        "private_server_lobby_port": 8441,
        "private_server_game_port": 8443,
        "gateway_proxy_port": 80,
        "resource_server_port": 8440,
    }

CONFIG = load_config()
SERVER_HOST = CONFIG["private_server_host"]
LOBBY_PORT = CONFIG["private_server_lobby_port"]
GAME_PORT = CONFIG["private_server_game_port"]
RESOURCE_PORT = CONFIG["resource_server_port"]
GATEWAY_PORT = CONFIG.get("gateway_proxy_port", 8080)


class LocalProxyHandler(BaseHTTPRequestHandler):
    """统一的本地代理处理器"""

    def do_GET(self):
        path = self.path
        print(f"[请求] {self.client_address[0]}:{self.client_address[1]} GET {path}")

        # Gateway 路由请求
        if "/api/clientgate/routes" in path:
            self.handle_routes()
            return

        # Gateway 版本更新检查
        if "/api/clientgate/upgrade_info" in path:
            self.handle_upgrade_info()
            return

        # Gateway 公告列表
        if "/api/clientgate/announce_list" in path:
            self.handle_announce_list()
            return

        # ClientBundleSettings
        if "/clientBundleSettings/" in path:
            self.handle_cdn_response("clientBundleSettings")
            return

        # WarehouseSettings
        if "/warehouseSettings/" in path:
            self.handle_cdn_response("warehouseSettings")
            return

        # bundle_hash.txt 和其他 /app/ 请求 -> 转发到资源服务器
        # (不再返回空，让资源服务器提供正确的 bundle_hash.txt)
        if path.startswith("/app/"):
            self.proxy_to_resource_server()
            return

        # 默认：转发到资源服务器
        self.proxy_to_resource_server()

    def do_POST(self):
        self.do_GET()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def handle_routes(self):
        """返回本地私服 WebSocket 地址（客户端期望的格式）"""
        # 客户端代码: V = json.decode(response); _OnFetchRoutes(id, url, V.data)
        # 路由对象需要: id, domain, ssl, state, level, order, name
        # 重要: chs_t PC版默认选择 route-1，所以ID必须匹配
        response_data = {
            "data": {
                "routes": [
                    {
                        "id": "route-1",
                        "domain": f"{SERVER_HOST}:{LOBBY_PORT}",
                        "ssl": False,
                        "state": "idle",
                        "level": 1,
                        "order": 1,
                        "name": "私服线路1",
                    },
                ]
            }
        }

        self.send_json(response_data)
        print(f"[代理] 路由请求 -> lobby={SERVER_HOST}:{LOBBY_PORT}")
        print(f"[代理] 响应内容: {json.dumps(response_data, ensure_ascii=False)}")

    def handle_upgrade_info(self):
        """返回空版本更新信息（不需要更新）"""
        # 客户端解析: json.decode(P).data.upgrade_list
        response_data = {
            "data": {
                "upgrade_list": [],
            }
        }
        self.send_json(response_data)
        print("[代理] 版本检查 -> 无需更新")

    def handle_announce_list(self):
        """返回空公告列表"""
        response_data = {
            "data": {
                "announce_list": [],
            }
        }
        self.send_json(response_data)
        print("[代理] 公告列表 -> 空")

    def handle_cdn_response(self, kind):
        """返回本地化的 CDN 配置"""
        if kind == "clientBundleSettings":
            data = {
                "warehouses": [{
                    "name": "release",
                    "urls": [{
                        "url": f"http://{SERVER_HOST}:{RESOURCE_PORT}",
                        "weight": 100000,
                        "TIMEOUT": 600000,
                        "Priority": 100,
                        "FASTTIMEOUT": 10000,
                    }],
                    "clientBundleSettings": "/app/v3/release/clientBundleSettings/",
                    "warehouseSettingPath": "/app/v3/release/warehouseSettings/chs_t-release.json",
                }],
            }
        elif kind == "warehouseSettings":
            data = {
                "urls": [{
                    "url": f"http://{SERVER_HOST}:{RESOURCE_PORT}",
                    "weight": 100000,
                    "TIMEOUT": 600000,
                    "Priority": 100,
                    "FASTTIMEOUT": 10000,
                }],
                "bundlePath": "/app/v3/release/ab/",
            }
        else:
            data = {}

        self.send_json(data)
        print(f"[代理] CDN {kind} -> 本地配置")

    def proxy_to_resource_server(self):
        """转发到本地资源服务器"""
        import urllib.request
        try:
            url = f"http://{SERVER_HOST}:{RESOURCE_PORT}{self.path}"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = resp.read()
                self.send_response(resp.status)
                for key, val in resp.getheaders():
                    if key.lower() not in ("transfer-encoding", "connection"):
                        self.send_header(key, val)
                self.end_headers()
                self.wfile.write(data)
                print(f"[代理] {self.path} -> {resp.status} ({len(data)} bytes)")
        except urllib.error.HTTPError as e:
            print(f"[代理] {self.path} -> {e.code} {e.reason}")
            self.send_error(e.code, e.reason)
        except Exception as e:
            print(f"[代理] {self.path} -> 错误: {e}")
            self.send_error(502, f"Resource server unreachable: {e}")

    def send_json(self, data):
        response_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(response_bytes)

    def log_message(self, format, *args):
        pass  # 静默默认日志，我们用自定义 print


def generate_self_signed_cert():
    """生成自签名 SSL 证书"""
    cert_dir = SCRIPT_DIR / "certs"
    cert_dir.mkdir(exist_ok=True)
    cert_file = cert_dir / "cert.pem"
    key_file = cert_dir / "key.pem"

    if cert_file.exists() and key_file.exists():
        return str(cert_file), str(key_file)

    print("[证书] 生成自签名 SSL 证书...")
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption
        import datetime

        now = datetime.datetime.now(datetime.timezone.utc)

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, "MahjongSoul Local Proxy"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Local"),
        ])

        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now)
            .not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(
                x509.SubjectAlternativeName([
                    x509.DNSName("*.catmajsoul.com"),
                    x509.DNSName("*.catmjstudio.com"),
                    x509.DNSName("*.maj-soul.com"),
                    x509.DNSName("*.mahjongsoul.com"),
                    x509.DNSName("*.aliyuncs.com"),
                    x509.DNSName("localhost"),
                    x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                ]),
                critical=False,
            )
            .sign(key, hashes.SHA256())
        )

        with open(cert_file, "wb") as f:
            f.write(cert.public_bytes(Encoding.PEM))
        with open(key_file, "wb") as f:
            f.write(key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()))

        print(f"[证书] 已生成: {cert_file}")
        return str(cert_file), str(key_file)

    except ImportError:
        print("[证书] cryptography 库未安装，尝试用 openssl 命令行...")
        try:
            os.system(f'openssl req -x509 -newkey rsa:2048 -keyout "{key_file}" -out "{cert_file}" -days 3650 -nodes -subj "/CN=MahjongSoul Local Proxy" 2>nul')
            if cert_file.exists() and key_file.exists():
                print(f"[证书] 已生成: {cert_file}")
                return str(cert_file), str(key_file)
        except:
            pass

        print("[证书] 无法生成 SSL 证书!")
        print("  请安装: pip install cryptography")
        return None, None


def start_http_server(port, handler_class):
    """启动 HTTP 服务器"""
    try:
        server = HTTPServer(("0.0.0.0", port), handler_class)
        print(f"  HTTP 监听: {port}")
        server.serve_forever()
    except OSError as e:
        print(f"  [警告] HTTP {port} 端口绑定失败: {e}（需要管理员权限）")


def start_https_server(port, handler_class, cert_file, key_file):
    """启动 HTTPS 服务器"""
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert_file, key_file)

        server = HTTPServer(("0.0.0.0", port), handler_class)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        print(f"  HTTPS 监听: {port}")
        server.serve_forever()
    except OSError as e:
        print(f"  [警告] HTTPS {port} 端口绑定失败: {e}（需要管理员权限）")
    except Exception as e:
        print(f"  [警告] HTTPS {port} 启动失败: {e}")


def main():
    print("=" * 60)
    print("  雀魂本地全功能代理")
    print("=" * 60)

    threads = []

    # 1. Gateway 代理 (8080)
    t = threading.Thread(target=start_http_server, args=(GATEWAY_PORT, LocalProxyHandler), daemon=True)
    t.start()
    threads.append(t)

    # 2. HTTP CDN 代理 (80)
    t = threading.Thread(target=start_http_server, args=(80, LocalProxyHandler), daemon=True)
    t.start()
    threads.append(t)

    # 3. HTTPS CDN 代理 (443)
    cert_file, key_file = generate_self_signed_cert()
    if cert_file and key_file:
        t = threading.Thread(target=start_https_server, args=(443, LocalProxyHandler, cert_file, key_file), daemon=True)
        t.start()
        threads.append(t)

    print()
    print(f"  大厅地址: ws://{SERVER_HOST}:{LOBBY_PORT}")
    print(f"  游戏地址: ws://{SERVER_HOST}:{GAME_PORT}")
    print(f"  资源服务: http://{SERVER_HOST}:{RESOURCE_PORT}")
    print()
    print("  按 Ctrl+C 停止代理")
    print("=" * 60)

    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        print("\n[代理] 已停止")
        sys.exit(0)


if __name__ == "__main__":
    main()
