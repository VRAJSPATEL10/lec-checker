FROM node:22-alpine

WORKDIR /app

COPY check-usc-seats.mjs usc-watch.json ./

ENV POLL_INTERVAL_SEC=60 \
    NODE_ENV=production

CMD ["node", "check-usc-seats.mjs"]
