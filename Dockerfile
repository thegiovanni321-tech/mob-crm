FROM node:22-alpine
WORKDIR /app
# the workbook / delta-CSV readers (scripts/extract_general.py) need python3 + openpyxl
RUN apk add --no-cache python3 py3-openpyxl
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
EXPOSE 3000
CMD ["node", "src/server.js"]
