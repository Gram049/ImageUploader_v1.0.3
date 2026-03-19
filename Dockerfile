FROM node:18-slim

# Instalar ffmpeg + ffprobe
RUN apt-get update && apt-get install -y ffmpeg \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Diretório da app
WORKDIR /app

# Copiar dependências
COPY package*.json ./

# Instalar dependências Node
RUN npm install --omit=dev

# Copiar código
COPY . .

# Porta usada pelo Fly
ENV PORT=3000
EXPOSE 3000

# Start
CMD ["npm", "start"]