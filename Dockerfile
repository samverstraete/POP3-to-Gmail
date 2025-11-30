# Use an LTS Node image
FROM node:lts-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies (no dev deps)
COPY package.json package-lock.json* ./
RUN npm install

# Copy app
COPY . .

# Ensure the application directory and its contents are owned by the unprivileged
# `node` user so the process can create logs and data inside the container.
RUN chown -R node:node /usr/src/app || true

# Create app-local logs directory and data directory (app will write here by default)
RUN mkdir -p /usr/src/app/logs /usr/src/app/data && chown -R node:node /usr/src/app/logs /usr/src/app/data

# Run the rest of the container as the unprivileged 'node' user
USER node
# Keep logs inside the app directory by default so the unprivileged node user can write
ENV LOG_DIR=./logs

# Default command — expects config.yaml and credentials.json present in datadir or mounted
CMD ["node", "pop3_to_gmail.js", "./data/config.yaml"]
