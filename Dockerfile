FROM node:18-alpine

# Install Python and FFmpeg
RUN apk add --no-cache python3 py3-pip ffmpeg

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install instead of npm ci)
RUN npm install --omit=dev

# Copy app files
COPY . .

# Expose port
EXPOSE 3000

# Start command
CMD ["npm", "start"]
