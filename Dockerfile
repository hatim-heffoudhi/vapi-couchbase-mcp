FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY ui ./ui
RUN npm ci
ENV HOST=0.0.0.0
ENV PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "src/changes-api.ts"]
