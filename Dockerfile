FROM nodered/node-red@sha256:0ed181c867c9ef19cf51dc4707f7fb54d1ad58a0227ab4e19732f6a3630c1b00
WORKDIR /opt/commute
COPY --chown=node-red:node-red package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node-red:node-red lib ./lib
COPY --chown=node-red:node-red tools ./tools
COPY --chown=node-red:node-red web ./web
COPY --chown=node-red:node-red flows.json /data/flows.json
COPY --chown=node-red:node-red settings.js /data/settings.js
WORKDIR /usr/src/node-red
