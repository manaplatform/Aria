FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /srv/aria
COPY --chown=node:node dist/ ./dist/
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
