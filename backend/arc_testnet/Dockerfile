FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Build step if using TS to JS (Optional, since we use tsx in start script, we can just run it)
# RUN npm run build

EXPOSE 3001

CMD ["npm", "start"]
