#!/bin/bash
# ============================================================
#  Morpheus WhatsApp Server — Instalador
#  Execute: bash instalar.sh
# ============================================================
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║   Morpheus WhatsApp Server — Instalador  ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. Node.js ────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Node.js não encontrado. Instalando...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo -e "${GREEN}✓ Node.js $(node -v)${NC}"
fi

# ── 2. Dependências ───────────────────────────────────────────
echo -e "${YELLOW}Instalando dependências npm...${NC}"
npm install --omit=dev
echo -e "${GREEN}✓ Dependências instaladas${NC}"

# ── 3. Arquivo .env ───────────────────────────────────────────
if [ ! -f .env ]; then
    cp .env.example .env
    # Gera API Key aleatória
    API_KEY="morpheus-$(openssl rand -hex 8)"
    sed -i "s/morpheus-wpp-2026/$API_KEY/" .env
    echo -e "${GREEN}✓ .env criado com API Key: ${CYAN}$API_KEY${NC}"
    echo -e "${YELLOW}⚠ Guarde esta chave! Configure-a no sistema Morpheus.${NC}"
else
    echo -e "${GREEN}✓ .env já existe${NC}"
fi

# ── 4. PM2 (processo persistente) ────────────────────────────
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}Instalando PM2...${NC}"
    sudo npm install -g pm2
fi

pm2 delete morpheus-wpp 2>/dev/null || true
pm2 start server.js --name morpheus-wpp --restart-delay=3000 --max-restarts=10
pm2 save
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true

echo -e "${GREEN}"
echo "╔══════════════════════════════════════════╗"
echo "║   ✅ Instalação concluída!               ║"
echo "╠══════════════════════════════════════════╣"
IP=$(curl -s ifconfig.me 2>/dev/null || echo "SEU_IP")
echo "║  URL:  http://$IP:3000"
echo "║  Logs: pm2 logs morpheus-wpp"
echo "║  Stop: pm2 stop morpheus-wpp"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo "Configure no Morpheus:"
echo "  Provedor   → Evolution API"
echo "  URL da API → http://$IP:3000"
echo "  Instância  → morpheus-pdv"
echo "  API Key    → $(grep API_KEY .env | cut -d= -f2)"
