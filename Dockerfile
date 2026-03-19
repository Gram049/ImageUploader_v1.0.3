# Dockerfile — Node 20 + ffmpeg + dependências nativas
FROM node:20-bullseye

# Instalar dependências do sistema para ffmpeg e módulos Node nativos
RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    python3 \
    pkg-config \
    libcairo2-dev \
    libjpeg-dev \
    libgif-dev \
    libpango1.0-dev \
    libpng-dev \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Definir diretório de trabalho
WORKDIR /app

# Copiar package.json + package-lock.json
COPY package*.json ./

# Instalar dependências de produção
RUN npm install --omit=dev

# Copiar restante do código
COPY . .

# Expõe porta padrão (mesma que o server.js)
EXPOSE 3000

# Comando para iniciar o servidor
CMD ["node", "server.js"]