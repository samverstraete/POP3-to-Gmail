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

# Install a tiny wrapper to drop privileges later. su-exec is lightweight and
# suitable for Alpine images.
RUN apk add --no-cache su-exec

# Add the entrypoint script which will run as root and chown mounted volumes
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The container will run the entrypoint (runs as root), which will chown the
# volumes and then drop privileges to the 'node' user before exec'ing the
# application's CMD.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Run the rest of the container as the unprivileged 'node' user
USER node
ENV LOG_DIR=/var/log/pop3_to_gmail

# Default command — expects config.yaml and credentials.json present in datadir or mounted
CMD ["node", "pop3_to_gmail.js", "./data/config.yaml"]
