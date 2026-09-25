FROM node:22-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json version.json ./
# Midscene (web, Android, iOS) and Playwright versions come from package-lock.json; Chromium matches that Playwright.
# ADB drives Android farm devices after `adb connect`; iOS talks to the farm's WebDriverAgent over HTTP.
RUN apt-get update \
  && apt-get install -y --no-install-recommends adb \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev --no-audit --no-fund \
  && npx playwright install --with-deps chromium \
  && (chmod +x node_modules/@ffmpeg-installer/linux-*/ffmpeg 2>/dev/null || true) \
  && npm cache clean --force
COPY src ./src
COPY public ./public
COPY cases ./cases
COPY scripts ./scripts
# The ADB key must survive container updates, otherwise the farm stops trusting this runner.
RUN ln -s /data/android /root/.android
ENV PORT=8080 DATA_DIR=/data REPORTS_DIR=/data/reports
VOLUME /data
EXPOSE 8080
CMD ["sh", "-c", "mkdir -p /data/android && exec node src/server.mjs"]
