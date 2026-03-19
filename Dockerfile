# --- imagem base ---
FROM node:20-slim

# --- diretório de trabalho ---
WORKDIR /app

# --- instalar ferramentas de build necessárias para dependências nativas ---
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# --- copiar package.json e package-lock.json para instalar dependências ---
COPY package*.json ./

# --- instalar dependências de produção ---
RUN npm install --omit=dev

# --- copiar resto do código ---
COPY . .

# --- expor porta do servidor ---
EXPOSE 3000

# --- comando para iniciar o server ---
CMD ["node", "server.js"]