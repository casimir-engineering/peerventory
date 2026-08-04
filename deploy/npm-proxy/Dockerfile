# Runs the inventory sync server + serves the built PWA.
# Context is the stack dir on the VPS: /opt/stacks/inventory
# Layout inside the image mirrors the repo: /app/server + /app/app/dist
FROM node:26-slim
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
COPY dist /app/app/dist
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "run", "start"]
