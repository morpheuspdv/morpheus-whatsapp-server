# Morpheus WhatsApp Server

Servidor WhatsApp próprio, gratuito, baseado em **Baileys** (open source).  
Expõe a mesma API da Evolution API — compatível com o sistema Morpheus sem nenhuma alteração.

## Instalação (VPS Ubuntu/Debian)

```bash
# 1. Copie esta pasta para o servidor
scp -r whatsapp-server/ usuario@SEU_VPS:~/

# 2. Entre na pasta e instale
cd ~/whatsapp-server
bash instalar.sh
```

O instalador cuida de tudo: Node.js, dependências, PM2 (processo persistente que reinicia automaticamente).

## Hospedagem gratuita

| Plataforma | Plano gratuito | Como usar |
|---|---|---|
| **Oracle Cloud** | 2 VMs ARM sempre grátis | Cria VM → scp → bash instalar.sh |
| **Railway** | US$5 crédito/mês | Deploy via GitHub |
| **Fly.io** | 3 VMs compartilhadas | fly launch |
| **Render** | Gratuito (dorme após 15min) | Não recomendado |

## Configuração no Morpheus

No sistema, aba **Configuração** do módulo WhatsApp:

- **Provedor**: Evolution API  
- **URL da API**: `http://SEU_IP:65002`  
- **Instância**: `morpheus-pdv`  
- **API Key**: *(gerada pelo instalar.sh — está no arquivo .env)*

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Healthcheck (sem autenticação) |
| GET | `/status` | Estado da conexão |
| GET | `/qr` | QR Code em base64 |
| POST | `/send` | Enviar mensagem `{phone, message}` |
| POST | `/logout` | Desconectar sessão |
| POST | `/reconnect` | Reconectar sem logout |

## Comandos úteis (PM2)

```bash
pm2 logs morpheus-wpp     # ver logs em tempo real
pm2 restart morpheus-wpp  # reiniciar
pm2 stop morpheus-wpp     # parar
pm2 status                # ver todos os processos
```
