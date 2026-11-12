FROM oven/bun:1.2-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV NODE_ENV=production PORT=3000
USER bun
EXPOSE 3000
CMD ["bun", "src/index.ts"]
