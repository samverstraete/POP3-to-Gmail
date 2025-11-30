# Use an LTS Node image
FROM node:lts-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies (no dev deps)
COPY package.json package-lock.json* ./
RUN npm install

# Copy app
COPY . .

# Create log directory and data directory. Ownership of bind-mounts is handled at
# container start by the entrypoint (so the container can fix host-owned mounts).
RUN mkdir -p /var/log/pop3_to_gmail /usr/src/app/data

# Run the rest of the container as the unprivileged 'node' user
USER node
ENV LOG_DIR=/var/log/pop3_to_gmail

# Default command — expects config.yaml and credentials.json present in datadir or mounted
CMD ["node", "pop3_to_gmail.js", "./data/config.yaml"]
