# Dockerfile para Image Uploader no Fly.io
# Base Node.js 20 com Debian Bullseye (estável)
FROM node:20-bullseye

# Instala ffmpeg e dependências nativas necessárias para módulos de imagem
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

# Define o diretório de trabalho
WORKDIR /app

# Copia os ficheiros de package para instalar dependências
COPY package*.json ./

# Instala todas as dependências (dev + prod) para evitar falhas de build de módulos nativos
RUN npm install

# Copia o restante do projeto
COPY . .

# Expõe a porta onde o server vai correr
EXPOSE 3000

# Comando para iniciar o server
CMD ["node", "server.js"]