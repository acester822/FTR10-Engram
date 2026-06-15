# ===== BUILD STAGE =====
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
ARG VITE_OM_API_URL=http://localhost:8080
ENV VITE_OM_API_URL=$VITE_OM_API_URL
RUN npx vite build

# ===== PRODUCTION STAGE =====
FROM node:20-bookworm-slim AS production

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev

EXPOSE 5173

CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
