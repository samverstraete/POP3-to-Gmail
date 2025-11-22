# Use an LTS Node image
FROM node:lts-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies (no dev deps)
COPY package.json package-lock.json* ./
RUN npm install

# Copy app
COPY . .

# Create log directory and a non-root user
RUN mkdir -p /var/log/pop3_to_gmail && chown -R node:node /var/log/pop3_to_gmail

USER node
ENV LOG_DIR=/var/log/pop3_to_gmail

# Default command — expects config.yaml and credentials.json present in workdir or mounted
CMD ["node", "pop3_to_gmail.js", "config.yaml"]
