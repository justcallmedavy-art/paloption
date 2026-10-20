# For hosts that want a container instead of a buildpack (Fly, Cloud Run, a VPS).
#
#   docker build -t strategyoption-api .
#   docker run -p 8080:8080 -e DATABASE_URL=... -e ALLOWED_ORIGINS=... strategyoption-api
#
# Only the production dependency (`pg`) is installed; the server has no other
# runtime dependency, and the test and Tailwind toolchains are dev-only.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The service: the API, the trading socket, and the mirrored client it can serve
# itself (handy for a single-host deployment, and how the suite drives it).
COPY tools ./tools
COPY site ./site

# Most container hosts assign the port; 8080 is their usual default.
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "tools/server.mjs"]
