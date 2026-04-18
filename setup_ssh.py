#!/usr/bin/env python3
"""
Morpheus WhatsApp Server — Configurador SSH
Conecta ao VPS via SSH, envia os arquivos e instala o servidor automaticamente.

Uso rápido (tudo pela linha de comando):
    python3 setup_ssh.py --host 1.2.3.4 --user ubuntu --key ~/.ssh/id_rsa
    python3 setup_ssh.py --host 1.2.3.4 --user root --password MinhaSenh@

Uso interativo (pergunta os dados):
    python3 setup_ssh.py

Dependência (instale uma vez):
    pip install paramiko
"""

import os
import sys
import time
import socket
import getpass
import argparse

# ── Verifica dependência ───────────────────────────────────────────────────────
try:
    import paramiko
except ImportError:
    print("❌  Paramiko não instalado.")
    print("    Execute: pip install paramiko")
    sys.exit(1)

# ══════════════════════════════════════════════════════════════════════════════
#  CONFIGURAÇÕES — preencha ou deixe em branco para digitar na hora
# ══════════════════════════════════════════════════════════════════════════════
DEFAULT_HOST  = ""          # ex: "192.168.1.10"  ou  "seu-servidor.com"
DEFAULT_PORT  = 22
DEFAULT_USER  = "ubuntu"    # usuário padrão Oracle Cloud / AWS
DEFAULT_KEY   = ""          # caminho para chave SSH, ex: "~/.ssh/id_rsa"
                            # deixe vazio para usar senha
REMOTE_DIR    = "~/whatsapp-server"   # pasta de destino no servidor

# Pasta local com os arquivos (detecta automaticamente)
LOCAL_DIR = os.path.dirname(os.path.abspath(__file__))

# Arquivos a enviar (relativos ao LOCAL_DIR)
FILES_TO_UPLOAD = [
    "server.js",
    "package.json",
    ".env.example",
    "instalar.sh",
    "README.md",
]

# ══════════════════════════════════════════════════════════════════════════════

CYAN   = "\033[0;36m"
GREEN  = "\033[0;32m"
YELLOW = "\033[1;33m"
RED    = "\033[0;31m"
BOLD   = "\033[1m"
NC     = "\033[0m"

def banner():
    print(f"{CYAN}")
    print("╔══════════════════════════════════════════════════╗")
    print("║   Morpheus WhatsApp Server — Configurador SSH    ║")
    print("╚══════════════════════════════════════════════════╝")
    print(f"{NC}")

def ok(msg):    print(f"{GREEN}✓  {msg}{NC}")
def warn(msg):  print(f"{YELLOW}⚠  {msg}{NC}")
def err(msg):   print(f"{RED}✗  {msg}{NC}")
def info(msg):  print(f"   {msg}")
def step(msg):  print(f"\n{BOLD}── {msg}{NC}")

def ask(prompt, default=""):
    if default:
        val = input(f"   {prompt} [{default}]: ").strip()
        return val or default
    else:
        val = input(f"   {prompt}: ").strip()
        return val

# ── Parser de argumentos CLI ──────────────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser(
        description="Morpheus WhatsApp Server — Configurador SSH",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            "Exemplos:\n"
            "  python3 setup_ssh.py --host 1.2.3.4 --user ubuntu --key ~/.ssh/id_rsa\n"
            "  python3 setup_ssh.py --host 1.2.3.4 --user root --password MinhaSenh@\n"
            "  python3 setup_ssh.py   ← modo interativo"
        )
    )
    p.add_argument("--host",     help="IP ou domínio do servidor")
    p.add_argument("--port",     type=int, default=DEFAULT_PORT, help=f"Porta SSH (padrão {DEFAULT_PORT})")
    p.add_argument("--user",     help=f"Usuário SSH (padrão: {DEFAULT_USER})")
    p.add_argument("--key",      help="Caminho para chave SSH privada (~/.ssh/id_rsa)")
    p.add_argument("--password", help="Senha SSH (use --key para mais segurança)")
    return p.parse_args()

# ── Coleta parâmetros de conexão ──────────────────────────────────────────────
def collect_params(args):
    step("Dados de conexão SSH")

    # Host
    host = args.host or ask("Host / IP do servidor", DEFAULT_HOST)
    if not host:
        err("Host obrigatório.")
        sys.exit(1)

    # Porta
    port = args.port or int(ask("Porta SSH", str(DEFAULT_PORT)))

    # Usuário
    user = args.user or ask("Usuário", DEFAULT_USER)

    # Chave SSH
    key_path = args.key or DEFAULT_KEY
    if not key_path and not args.password:
        key_path = ask("Chave SSH (Enter para usar senha)", "")
    if key_path:
        key_path = os.path.expanduser(key_path)
        if not os.path.exists(key_path):
            warn(f"Chave não encontrada: {key_path}")
            key_path = ""

    # Senha
    password = args.password if args.password else None
    if not key_path and not password:
        password = getpass.getpass(f"   Senha do usuário '{user}': ")

    return host, port, user, key_path or None, password

# ── Conecta SSH ───────────────────────────────────────────────────────────────
def ssh_connect(host, port, user, key_path, password):
    step(f"Conectando a {user}@{host}:{port}")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        if key_path:
            client.connect(host, port=port, username=user,
                           key_filename=key_path, timeout=15)
        else:
            client.connect(host, port=port, username=user,
                           password=password, timeout=15)
        ok(f"Conectado!")
        return client
    except (paramiko.AuthenticationException, paramiko.SSHException) as e:
        err(f"Falha de autenticação: {e}")
        sys.exit(1)
    except (socket.timeout, socket.error) as e:
        err(f"Não foi possível conectar: {e}")
        sys.exit(1)

# ── Roda comando remoto e imprime output ──────────────────────────────────────
def run(client, cmd, show=True):
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True)
    out = ""
    for line in iter(stdout.readline, ""):
        out += line
        if show:
            print(f"   {line}", end="")
    exit_code = stdout.channel.recv_exit_status()
    return exit_code, out

# ── Upload dos arquivos via SFTP ──────────────────────────────────────────────
def upload_files(client, remote_dir):
    step("Enviando arquivos")

    sftp = client.open_sftp()

    # Cria pasta remota
    run(client, f"mkdir -p {remote_dir}", show=False)

    for fname in FILES_TO_UPLOAD:
        local_path = os.path.join(LOCAL_DIR, fname)
        if not os.path.exists(local_path):
            warn(f"Arquivo local não encontrado: {fname} — pulando")
            continue
        remote_path = f"{remote_dir}/{fname}"
        try:
            sftp.put(local_path, remote_path.replace("~", f"/home/{sftp.normalize('.')}"))
        except Exception:
            # Tenta via caminho absoluto expandido pelo servidor
            _, home, _ = client.exec_command("echo $HOME")
            home = home.read().decode().strip()
            real_remote = f"{home}/whatsapp-server/{fname}"
            sftp.put(local_path, real_remote)
        ok(f"Enviado: {fname}")

    sftp.close()

# ── Expande ~ no servidor ─────────────────────────────────────────────────────
def resolve_remote_dir(client, remote_dir):
    _, out, _ = client.exec_command(f"echo {remote_dir}")
    return out.read().decode().strip()

# ── Instalação ────────────────────────────────────────────────────────────────
def install(client, remote_dir):
    real_dir = resolve_remote_dir(client, remote_dir)

    step("Instalando Node.js (se necessário)")
    code, _ = run(client, "node -v", show=False)
    if code != 0:
        info("Node.js não encontrado. Instalando versão 20...")
        run(client, "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs")
    else:
        _, ver, _ = client.exec_command("node -v")
        ok(f"Node.js {ver.read().decode().strip()} já instalado")

    step("Instalando dependências npm")
    code, _ = run(client, f"cd {real_dir} && npm install --omit=dev")
    if code != 0:
        err("Erro no npm install")
        sys.exit(1)
    ok("Dependências instaladas")

    step("Criando arquivo .env")
    code, _ = run(client, f"test -f {real_dir}/.env", show=False)
    if code != 0:
        # Gera API key aleatória no servidor
        _, key_out, _ = client.exec_command("openssl rand -hex 8")
        rand = key_out.read().decode().strip()
        api_key = f"morpheus-{rand}"
        run(client, f"cp {real_dir}/.env.example {real_dir}/.env && "
                    f"sed -i 's/morpheus-wpp-2026/{api_key}/' {real_dir}/.env", show=False)
        ok(f".env criado  →  API Key: {CYAN}{api_key}{NC}")
        print(f"\n   {YELLOW}⚠  Anote essa chave! Configure-a no Morpheus.{NC}\n")
    else:
        ok(".env já existe")
        # Lê API Key existente
        _, key_out, _ = client.exec_command(f"grep API_KEY {real_dir}/.env | cut -d= -f2")
        api_key = key_out.read().decode().strip()
        info(f"API Key atual: {CYAN}{api_key}{NC}")

    step("Instalando PM2 (gerenciador de processo)")
    code, _ = run(client, "pm2 -v", show=False)
    if code != 0:
        run(client, "sudo npm install -g pm2")
    ok("PM2 pronto")

    step("Iniciando servidor WhatsApp")
    run(client, f"pm2 delete morpheus-wpp 2>/dev/null || true", show=False)
    code, _ = run(client, f"cd {real_dir} && pm2 start server.js --name morpheus-wpp "
                          f"--restart-delay=3000 --max-restarts=10")
    run(client, "pm2 save", show=False)
    run(client, "pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true", show=False)
    if code == 0:
        ok("Servidor iniciado com PM2")
    else:
        err("Erro ao iniciar servidor")

    return api_key

# ── IP público + resultado final ──────────────────────────────────────────────
def show_result(client, api_key, port=65002):
    _, ip_out, _ = client.exec_command("curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'")
    ip = ip_out.read().decode().strip()

    print(f"\n{GREEN}")
    print("╔══════════════════════════════════════════════════════╗")
    print("║   ✅ Instalação concluída!                           ║")
    print("╠══════════════════════════════════════════════════════╣")
    print(f"║  URL do servidor:  http://{ip}:{port}")
    print(f"║  API Key:          {api_key}")
    print("╠══════════════════════════════════════════════════════╣")
    print("║  Configure no Morpheus:                              ║")
    print("║    Provedor   → Evolution API (compatível)           ║")
    print(f"║    URL da API → http://{ip}:{port}")
    print("║    Instância  → morpheus-pdv                        ║")
    print(f"║    API Key    → {api_key}")
    print("╠══════════════════════════════════════════════════════╣")
    print("║  Comandos úteis no servidor:                         ║")
    print("║    pm2 logs morpheus-wpp   ← ver logs               ║")
    print("║    pm2 restart morpheus-wpp                         ║")
    print("║    pm2 status                                        ║")
    print("╚══════════════════════════════════════════════════════╝")
    print(f"{NC}")

# ── Verifica se o servidor está rodando ──────────────────────────────────────
def health_check(client, ip, port=65002):
    step("Verificando servidor (healthcheck)")
    time.sleep(3)  # aguarda o processo iniciar
    code, out = run(client, f"curl -s http://localhost:{port}/health", show=False)
    if code == 0 and "ok" in out:
        ok("Servidor respondendo na porta " + str(port))
    else:
        warn("Servidor pode ainda estar iniciando. Verifique com: pm2 logs morpheus-wpp")

# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════
def main():
    banner()

    args = parse_args()

    # Verifica arquivos locais
    missing = [f for f in FILES_TO_UPLOAD if not os.path.exists(os.path.join(LOCAL_DIR, f))]
    if missing:
        warn(f"Arquivos não encontrados localmente: {', '.join(missing)}")
        info("Execute este script a partir da pasta whatsapp-server/")

    # Coleta dados
    host, port, user, key_path, password = collect_params(args)

    # Conecta
    client = ssh_connect(host, port, user, key_path, password)

    try:
        # Envia arquivos
        remote_dir = REMOTE_DIR
        real_dir   = resolve_remote_dir(client, remote_dir)
        upload_files(client, remote_dir)

        # Instala
        api_key = install(client, remote_dir)

        # Healthcheck
        _, ip_out, _ = client.exec_command("curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'")
        ip = ip_out.read().decode().strip()
        health_check(client, ip)

        # Resultado
        show_result(client, api_key)

    finally:
        client.close()

if __name__ == "__main__":
    main()
